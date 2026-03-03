/**
 * AvatarInterviewer.tsx  — v5
 *
 * New in v5:
 *  • MediaPipe FaceLandmarker  → real-time blendshape → VRM expression mapping
 *  • MediaPipe GestureRecognizer → hand-to-mouth detection
 *  • Head mirroring: webcam pitch/yaw/roll → VRM neck bone
 *  • Giggling animation: happy + hand-to-mouth → head-tilt bounce
 *  • Bored idle: no motion detected → dramatic look-away + weight-shift
 *  • Hand-to-mouth arm IK: right arm lifts toward avatar's face
 *
 * Architecture — two independent loops:
 *   MediaPipe rAF ──► trackingRef (plain object) ──► Three.js useFrame
 *   No React state involved in the hot path; zero re-renders from tracking.
 */
import { useRef, useState, useEffect, useCallback, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMLoaderPlugin,
  VRM,
  VRMHumanBoneName,
  VRMExpressionPresetName,
} from '@pixiv/three-vrm';
import {
  useMediaPipeTracking,
  type TrackingData,
} from '../hooks/useMediaPipeTracking';

// ─── constants ────────────────────────────────────────────────────────────────
const AVATAR_URL    = '/Anurag.vrm';
const SILENCE_RMS   = 0.015;
const SHOUT_RMS     = 0.10;
const BAND_AMP      = 2.4;

// ─── types ────────────────────────────────────────────────────────────────────
export type EmotionMode  = 'neutral' | 'angry' | 'happy' | 'sad';
export type BehaviorMode = 'neutral' | 'loudLaugh' | 'shyGiggle' | 'guilty' | 'angry' | 'blush';
type EK = 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'blink' | 'angry' | 'happy' | 'sad' | 'relaxed' | 'surprised';

// ─── EMOTION PROFILES ─────────────────────────────────────────────────────────
interface EmotionProfile {
  lipMult:   number;
  viseme:    { aa: number; ee: number; ih: number; oh: number; ou: number };
  secondary: Partial<Record<EK, number>>;
  alphaOverride?: Partial<Record<EK, number>>;
  headReactThreshold: number;
}

const EMOTION_PROFILES: Record<EmotionMode, EmotionProfile> = {
  neutral: {
    lipMult: 1.0,
    viseme:  { aa:1.0, ee:0.80, ih:0.80, oh:1.00, ou:1.00 },
    secondary: { relaxed: 0.25 },
    headReactThreshold: SHOUT_RMS,
  },
  angry: {
    lipMult: 1.35,
    viseme:  { aa:1.20, ee:1.50, ih:1.60, oh:0.60, ou:0.40 },
    secondary: { angry: 0.90 },
    alphaOverride: { aa:0.40, ee:0.35, ih:0.38 },
    headReactThreshold: SHOUT_RMS * 0.6,
  },
  happy: {
    lipMult: 1.10,
    viseme:  { aa:1.30, ee:1.40, ih:0.80, oh:0.80, ou:0.60 },
    secondary: { happy: 0.75, relaxed: 0.20 },
    headReactThreshold: SHOUT_RMS * 1.5,
  },
  sad: {
    lipMult: 0.60,
    viseme:  { aa:0.60, ee:0.40, ih:0.40, oh:1.20, ou:1.40 },
    secondary: { sad: 0.80, relaxed: 0.10 },
    alphaOverride: { aa:0.14, oh:0.18, ou:0.16 },
    headReactThreshold: 9999,
  },
};

// ─── BEHAVIOR EXPRESSION PROFILES ──────────────────────────────────────────
// Per-behavior expression targets — applied as a max-blend on top of audio+tracking.
// Maps to VRM preset names only (blush/browDown etc. are custom and silently ignored
// if the VRM doesn't ship them; add as custom expressions in VRM editor if needed).
const BEHAVIOR_EXPRESSIONS: Record<BehaviorMode, Partial<Record<EK, number>>> = {
  neutral:   {},   // no override; falls through to emotionMode + audio
  // head thrown back, mouth wide open, eyes squint closed
  loudLaugh: { happy: 1.0, aa: 1.0, blink: 0.80 },
  // shy half-blink, slight smile, relaxed
  shyGiggle: { happy: 0.70, blink: 0.40, relaxed: 0.35 },
  // sorrow, droopy — brow up (sad), mouth slightly open
  guilty:    { sad: 0.85, relaxed: 0.20, blink: 0.25 },
  // full angry preset; surprised raises brows for wild-eyed look
  angry:     { angry: 1.0, surprised: 0.25 },
  // flushed cheeks — happy tint + half-close + relaxed
  blush:     { happy: 0.40, relaxed: 0.90, blink: 0.30 },
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += data[i];
  return Math.min(s / (hi - lo) / 255, 1);
}
const lp = THREE.MathUtils.lerp;
const cl = THREE.MathUtils.clamp;

// ─── VRMAvatarMesh ─────────────────────────────────────────────────────────────
interface MeshProps {
  analyserRef:  React.RefObject<AnalyserNode | null>;
  trackingRef:  React.RefObject<TrackingData>;
  emotionMode:  EmotionMode;
  behaviorMode: BehaviorMode;
  isNodding:    boolean;
  isShaking:    boolean;
  onNodEnd:     () => void;
  onShakeEnd:   () => void;
}

function VRMAvatarMesh({
  analyserRef, trackingRef, emotionMode, behaviorMode,
  isNodding, isShaking, onNodEnd, onShakeEnd,
}: MeshProps) {
  const { camera } = useThree();
  const groupRef   = useRef<THREE.Group>(null!);
  const vrmRef     = useRef<VRM | null>(null);

  // audio buffers
  const freqBuf = useRef<Uint8Array | null>(null);
  const timeBuf = useRef<Uint8Array | null>(null);
  const sRms    = useRef(0);

  // smoothed expression current values
  const curExpr = useRef<Record<EK, number>>({
    aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0, surprised:0,
  });

  // auto-blink clock (used only when tracking inactive)
  const nextBlink = useRef(0);
  const blinkT    = useRef(-1);

  const swP = useRef(Math.random() * Math.PI * 2);

  // nod / shake
  const nodT      = useRef(0);
  const shakeT    = useRef(0);
  const nodDone   = useRef(false);
  const shakeDone = useRef(false);
  const prevNod   = useRef(false);
  const prevShake = useRef(false);

  const jitP = useRef(0);

  // micro-jitter eye lookAt
  const jitterObj   = useRef(new THREE.Object3D());
  const jitterGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const jitterNextT = useRef(0);

  // ── Module 3 refs ─────────────────────────────────────────────────────────
  // Nystagmus (neutral/sad eye dart): fast micro-saccades in a narrow FOV
  const nystagmusGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const nystagmusTimer = useRef(0);
  // Head-position vibration (loudLaugh): direct position offset on head bone
  // Decays to zero when not active so it never sticks.
  const headVibDecay   = useRef(new THREE.Vector3());

  // ── giggle state ───────────────────────────────────────────────────────────
  // Activated when tracking.isGiggling is true.
  // Head tilts + bounces, arm stays raised at mouth.
  const gigglingT   = useRef(-1);   // -1 = not giggling, ≥0 = elapsed time
  const prevGiggle  = useRef(false);

  // ── bored idle state ───────────────────────────────────────────────────────
  // Activated when tracking.isBored is true.
  const boredLookYaw   = useRef(0);    // current look-away yaw target
  const boredLookTimer = useRef(0);    // next time to pick a new look direction
  const boredSwayPh    = useRef(0);    // phase for weight-shift sway

  // ── load VRM ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));
    loader.load(
      AVATAR_URL,
      gltf => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) { console.error('[VRM] no vrm in userData'); return; }
        vrm.lookAt.target = jitterObj.current;
        groupRef.current.add(vrm.scene);
        vrmRef.current = vrm;

        // ── FIX T-POSE: set resting arm/hand angles on every bone immediately ──────
        // Uses getRawBoneNode so the value sticks in the skeleton's local space.
        // useFrame's lerp targets then animate ON TOP of these resting rotations.
        type BoneInit = [VRMHumanBoneName, number, number, number];
        const REST: BoneInit[] = [
          // Upper arms drop down from T-pose shoulder abduction
          [VRMHumanBoneName.LeftUpperArm,   0.0,  0.0,  Math.PI / 2.5],
          [VRMHumanBoneName.RightUpperArm,  0.0,  0.0, -Math.PI / 2.5],
          // Lower arms hang slightly relaxed (small inward rotation)
          [VRMHumanBoneName.LeftLowerArm,   0.0,  0.0,  0.08],
          [VRMHumanBoneName.RightLowerArm,  0.0,  0.0, -0.08],
          // Hands: neutral slight palmward curl
          [VRMHumanBoneName.LeftHand,       0.04, 0.0,  0.06],
          [VRMHumanBoneName.RightHand,      0.04, 0.0, -0.06],
        ];
        for (const [name, rx, ry, rz] of REST) {
          const bone = vrm.humanoid.getRawBoneNode(name);
          if (bone) { bone.rotation.set(rx, ry, rz); }
        }

        console.groupCollapsed('[VRM] bones');
        for (const name of Object.values(VRMHumanBoneName)) {
          const r = vrm.humanoid.getRawBoneNode(name);
          const n = vrm.humanoid.getNormalizedBoneNode(name);
          if (r || n) console.log(name, { raw: r?.name, norm: n?.name });
        }
        console.groupEnd();
      },
      undefined,
      err => console.error('[VRM] load error', err),
    );
    return () => {
      if (vrmRef.current) { groupRef.current?.remove(vrmRef.current.scene); vrmRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setExpr(name: EK, v: number) {
    vrmRef.current?.expressionManager?.setValue(name as VRMExpressionPresetName, v);
  }

  // ── per-frame ──────────────────────────────────────────────────────────────
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const now     = state.clock.elapsedTime;
    const profile = EMOTION_PROFILES[emotionMode];
    const T       = trackingRef.current;
    const tracked = T.active;
    const h       = vrm.humanoid;   // hoisted — shared by all three layers

    swP.current         += delta * 0.28;
    boredSwayPh.current += delta * 0.12;

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 1 ── ALWAYS-ALIVE BASE  (spine/chest breathing + idle blink timer)
    // Never suppressed — this is the heartbeat that proves the avatar is ‘awake’.
    // Targets Spine + Chest bones only so it never conflicts with neck/arm overrides.
    // ══════════════════════════════════════════════════════════════════════
    {
      // ~4 s per breath (0.25 Hz).  +X = chest expands forward / upward.
      const BREATH  = 0.25 * Math.PI * 2;   // angular frequency rad/s
      const inhale  = Math.sin(now * BREATH);
      const exhale  = Math.cos(now * BREATH);
      const BAMP    = 0.005;                // subtle — barely perceptible

      const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
      const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
      // Spine takes ~40 % of the swell; Chest the remaining 60 %
      if (spine) {
        spine.rotation.x = lp(spine.rotation.x, -inhale * BAMP * 0.40, 0.05);
        spine.rotation.z = lp(spine.rotation.z,  exhale * BAMP * 0.15, 0.04);
      }
      if (chest) {
        chest.rotation.x = lp(chest.rotation.x, -inhale * BAMP * 0.60, 0.05);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // EYE LOOK-AT (supporting Layer 1) — nystagmus / lazy / jitter
    // ══════════════════════════════════════════════════════════════════════
    {
      const cp = new THREE.Vector3();
      camera.getWorldPosition(cp);

      // Nystagmus: neutral/sad + no active tracking — rapid eye darts within a narrow FOV
      //   Simulates non-engagement / "staring through" rather than laser eye-lock.
      const isNystagmus = !tracked && (behaviorMode === 'neutral' || emotionMode === 'sad');
      // Lazy follow: shy/blush behaviours never snap; eyes drift lazily toward camera
      const isLazy = behaviorMode === 'shyGiggle' || behaviorMode === 'blush';

      if (isNystagmus) {
        if (now >= nystagmusTimer.current) {
          nystagmusGoal.current.set(
            cp.x + (Math.random() - 0.5) * 0.070,
            cp.y + (Math.random() - 0.5) * 0.050,
            cp.z,
          );
          nystagmusTimer.current = now + 0.15 + Math.random() * 0.30;
        }
        // Fast saccade toward goal (22×Δt makes it dart, not float)
        jitterObj.current.position.lerp(nystagmusGoal.current, delta * 22.0);
      } else {
        if (now >= jitterNextT.current) {
          jitterGoal.current.set(
            cp.x + (Math.random() - 0.5) * 0.06,
            cp.y + (Math.random() - 0.5) * 0.04,
            cp.z,
          );
          jitterNextT.current = now + 2.0 + Math.random() * 2.0;
        }
        // Alpha controls how quickly the eyes "catch up" to the camera:
        //   angry → snaps (9×), loudLaugh → floaty (3.5×), lazy shy/blush → dreamy (1.8×)
        const lookAlpha =
          isLazy               ? delta * 1.8
          : behaviorMode === 'angry'     ? delta * 9.0
          : behaviorMode === 'loudLaugh' ? delta * 3.5
          : delta * 6.0;
        jitterObj.current.position.lerp(jitterGoal.current, lookAlpha);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 2 ── FACE & SPEECH  (audio analyser + MediaPipe blendshapes → visemes)
    // Targets the face mesh expressions only. Runs in PARALLEL with Layer 1.
    // Bones and expressions are separate data: no conflict.
    // ══════════════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════════════
    const tgt: Record<EK, number> = {
      aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0, surprised:0,
    };

    // Profile secondary baseline
    for (const [k, v] of Object.entries(profile.secondary)) {
      tgt[k as EK] = v as number;
    }

    let isSpeaking = false;
    let headReact  = false;

    // ── Audio lip-sync ─────────────────────────────────────────────────────
    const analyser = analyserRef.current;
    if (analyser) {
      if (!freqBuf.current) freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuf.current) timeBuf.current  = new Uint8Array(analyser.fftSize);

      analyser.getByteTimeDomainData(timeBuf.current);
      let sq = 0;
      for (let i = 0; i < timeBuf.current.length; i++) {
        const s = (timeBuf.current[i] - 128) / 128;
        sq += s * s;
      }
      const rms = Math.sqrt(sq / timeBuf.current.length);
      sRms.current = lp(sRms.current, rms, 0.28);

      isSpeaking = sRms.current > SILENCE_RMS;
      headReact  = sRms.current > profile.headReactThreshold;

      if (isSpeaking) {
        analyser.getByteFrequencyData(freqBuf.current);
        const N = freqBuf.current.length;
        const t = Math.floor(N / 3);
        const rL = bandAvg(freqBuf.current, 0, t);
        const rM = bandAvg(freqBuf.current, t, t * 2);
        const rH = bandAvg(freqBuf.current, t * 2, N);
        const vol  = Math.pow(cl(sRms.current / 0.12, 0, 1), 0.70);
        const low  = cl(rL * BAND_AMP, 0, 1);
        const mid  = cl(rM * BAND_AMP, 0, 1);
        const high = cl(rH * BAND_AMP, 0, 1);
        const pv   = profile.viseme;
        const lm   = profile.lipMult;

        tgt.aa = cl(mid  * vol * 1.40 * pv.aa * lm, 0, 1);
        tgt.ee = cl(mid  * vol * 0.75 * pv.ee * lm, 0, 1);
        tgt.ih = cl(high * vol * 1.10 * pv.ih * lm, 0, 1);
        tgt.oh = cl(low  * vol * 1.10 * pv.oh * lm, 0, 1);
        tgt.ou = cl(low  * Math.max(0, 0.45 - tgt.aa) * vol * 1.60 * pv.ou * lm, 0, 1);

        for (const [k, v] of Object.entries(profile.secondary)) {
          tgt[k as EK] = cl((v as number) * (0.6 + vol * 0.4), 0, 1);
        }
        if (emotionMode === 'happy') tgt.happy = cl(high * vol * 1.10 + 0.6, 0, 1);
        if (headReact && emotionMode === 'angry') { tgt.angry = 1.0; tgt.aa = cl(tgt.aa * 1.25, 0, 1); }
      }
    }

    // ── MediaPipe blendshapes OVERRIDE / BLEND when tracking is active ──────
    if (tracked) {
      // Blinks: tracking owns blinks completely (prevents conflicts with clock blinks)
      tgt.blink = cl(Math.max(T.eyeBlinkLeft, T.eyeBlinkRight), 0, 1);

      // Lip-sync: take the max of audio-driven and face-driven so both contribute
      tgt.aa = cl(Math.max(tgt.aa, T.jawOpen      * 0.90), 0, 1);
      tgt.oh = cl(Math.max(tgt.oh, T.mouthPucker  * 0.85), 0, 1);
      tgt.ou = cl(Math.max(tgt.ou, T.mouthFunnel  * 0.85), 0, 1);

      // Smile → happy (direct override, scaled slightly)
      tgt.happy  = cl(Math.max(tgt.happy, T.mouthSmile * 1.20), 0, 1);

      // Inner brow up → sad (subtle)
      tgt.sad    = cl(Math.max(tgt.sad,   T.browInnerUp * 0.60), 0, 1);

      // Bored: avatar looks a bit tired
      if (T.isBored) {
        tgt.relaxed = cl(tgt.relaxed + 0.30, 0, 1);
      }

      // Giggling: add a happy boost
      if (T.isGiggling) {
        tgt.happy = 1.0;
      }
    }

    // ── MODULE 1B: Behavior expression overlay (max-blend over audio + tracking) ──────
    // behaviorMode expressions win when they're stronger than what audio/tracking drove.
    // This lets 'loudLaugh' force aa=1 / happy=1 even when mic is quiet.
    if (behaviorMode !== 'neutral') {
      const bExp = BEHAVIOR_EXPRESSIONS[behaviorMode];
      for (const [k, v] of Object.entries(bExp)) {
        tgt[k as EK] = cl(Math.max(tgt[k as EK] ?? 0, v as number), 0, 1);
      }
    } else {
      // ── Clock-based blinks (only when tracking is off) ───────────────────
      if (nextBlink.current === 0) nextBlink.current = now + 2 + Math.random() * 2;
      if (blinkT.current < 0 && now >= nextBlink.current) {
        blinkT.current    = now;
        nextBlink.current = now + 3.0 + Math.random() * 2.0;
      }
      if (blinkT.current >= 0) {
        const HALF = 0.07;
        const el   = now - blinkT.current;
        tgt.blink  = el < HALF ? el / HALF : Math.max(0, 1 - (el - HALF) / HALF);
        if (el >= HALF * 2) blinkT.current = -1;
      }
    }

    // ── Lerp + apply all expressions ─────────────────────────────────────────
    const ALPHA: Record<EK, number> = {
      aa:0.28, ee:0.20, ih:0.20, oh:0.24, ou:0.18,
      blink:0.90, angry:0.18, happy:0.14, sad:0.12, relaxed:0.10, surprised:0.15,
    };
    if (profile.alphaOverride) {
      for (const [k, v] of Object.entries(profile.alphaOverride)) ALPHA[k as EK] = v as number;
    }
    // Tracking: faster alpha for face-driven channels so they feel responsive
    if (tracked) {
      ALPHA.blink = 0.92;
      ALPHA.aa    = 0.38;
      ALPHA.happy = 0.25;
    }
    for (const k of Object.keys(tgt) as EK[]) {
      curExpr.current[k] = lp(curExpr.current[k], tgt[k], ALPHA[k]);
      setExpr(k, curExpr.current[k]);
    }
    vrm.expressionManager?.update();

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 3 ── LLM ACTION OVERRIDES  (switch on behaviorMode)
    // Overrides neck/head/arm bone rotations based on the current behavior.
    // Each case lerps toward its pose; the 'neutral' fallthrough lerps ALL
    // bones gently back toward zero so Layer 1 breathing remains visible.
    // ══════════════════════════════════════════════════════════════════════
    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);

    if (neck && head) {
      // Nod / shake edge detection
      if (isNodding  && !prevNod.current)   { nodT.current   = 0; nodDone.current   = false; }
      if (isShaking  && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current   = isNodding;
      prevShake.current = isShaking;

      // Giggle edge detection
      if (tracked && T.isGiggling && !prevGiggle.current) {
        gigglingT.current = 0;
      }
      if (!T.isGiggling) gigglingT.current = -1;
      prevGiggle.current = tracked && T.isGiggling;
      if (gigglingT.current >= 0) gigglingT.current += delta;

      if (isNodding) {
        // ── NOD (highest priority) ────────────────────────────────────────
        nodT.current += delta;
        if (nodT.current < 2.0) {
          head.rotation.x = Math.sin(nodT.current * Math.PI * 2.5) * 0.18;
          head.rotation.y = lp(head.rotation.y, 0, 0.08);
          head.rotation.z = lp(head.rotation.z, 0, 0.08);
          neck.rotation.x = lp(neck.rotation.x, 0, 0.06);
          neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        } else {
          head.rotation.x = lp(head.rotation.x, 0, 0.10);
          if (!nodDone.current) { nodDone.current = true; onNodEnd(); }
        }

      } else if (isShaking) {
        // ── SHAKE ─────────────────────────────────────────────────────────
        shakeT.current += delta;
        if (shakeT.current < 2.0) {
          head.rotation.y = Math.sin(shakeT.current * Math.PI * 3.5) * 0.18;
          head.rotation.x = lp(head.rotation.x, 0, 0.08);
          head.rotation.z = lp(head.rotation.z, 0, 0.08);
          neck.rotation.x = lp(neck.rotation.x, 0, 0.06);
          neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        } else {
          head.rotation.y = lp(head.rotation.y, 0, 0.10);
          if (!shakeDone.current) { shakeDone.current = true; onShakeEnd(); }
        }

      } else if (tracked && gigglingT.current >= 0) {
        // ── GIGGLING: head tilts + bounces, hand covers mouth ─────────────
        // Continuous while T.isGiggling — applies on top of tracking pose
        const gig = gigglingT.current;
        const bounce = Math.sin(gig * Math.PI * 8.0) * 0.06;    // 8 Hz bounce
        // Apply tracking head pose first, then add giggle motion on top
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.5, 0.10);
        neck.rotation.y = lp(neck.rotation.y, T.headYaw   * 0.4, 0.10);
        neck.rotation.z = lp(neck.rotation.z, T.headRoll  * 0.4, 0.10);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.5 + bounce, 0.15);
        head.rotation.y = lp(head.rotation.y, T.headYaw   * 0.6, 0.12);
        head.rotation.z = lp(head.rotation.z, T.headRoll  * 0.6 + 0.15 + Math.sin(gig * 5.0) * 0.04, 0.12);

      } else if (behaviorMode === 'loudLaugh') {
        // ── MODULE 2A: LOUD LAUGH — neck arcs back, head thrown, slow sine sway ───────
        // jitP is repurposed as the sway phase oscillator here
        jitP.current += delta * 1.5;
        neck.rotation.x = lp(neck.rotation.x, -0.32, 0.10);   // arc back
        neck.rotation.z = lp(neck.rotation.z,  0.0,  0.08);
        head.rotation.x = lp(head.rotation.x, -0.40, 0.10);   // throw back
        head.rotation.y = lp(head.rotation.y,  Math.sin(jitP.current * 0.8) * 0.12, 0.06);
        head.rotation.z = lp(head.rotation.z,  Math.sin(jitP.current * 1.1) * 0.06, 0.06);

      } else if (behaviorMode === 'shyGiggle') {
        // ── MODULE 2B: SHY GIGGLE — head down + tilted, gentle bob, eyes averted ───
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x,  0.22, 0.08);   // look down
        neck.rotation.z = lp(neck.rotation.z,  0.12, 0.06);   // shy tilt
        head.rotation.x = lp(head.rotation.x,  0.18 + Math.sin(now * 6.0) * 0.012, 0.08);
        head.rotation.y = lp(head.rotation.y,  0.15, 0.06);   // avert gaze
        head.rotation.z = lp(head.rotation.z,  0.10, 0.06);

      } else if (behaviorMode === 'guilty') {
        // ── MODULE 2C: GUILTY — head fully bowed, deep forward slump ──────────────
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x,  0.55, 0.05);
        neck.rotation.z = lp(neck.rotation.z,  0.04, 0.04);
        head.rotation.x = lp(head.rotation.x,  0.60, 0.05);   // full bow
        head.rotation.y = lp(head.rotation.y,  0,    0.04);
        head.rotation.z = lp(head.rotation.z,  0,    0.04);

      } else if (behaviorMode === 'angry') {
        // ── MODULE 2D: ANGRY BEHAVIOR — forward lean; Z-shake added in Module 3 ───
        jitP.current += delta * 28;
        neck.rotation.x = lp(neck.rotation.x,  0.15, 0.12);
        neck.rotation.z = lp(neck.rotation.z,  0,    0.10);
        head.rotation.x = lp(head.rotation.x,  0.10, 0.12);
        head.rotation.y = lp(head.rotation.y,  0,    0.10);

      } else if (behaviorMode === 'blush') {
        // ── MODULE 2E: BLUSH — head slightly down + shy tilt, dreamy look ────────
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x,  0.10, 0.05);
        neck.rotation.z = lp(neck.rotation.z,  0.08, 0.05);
        head.rotation.x = lp(head.rotation.x,  0.08, 0.05);
        head.rotation.y = lp(head.rotation.y,  0,    0.04);
        head.rotation.z = lp(head.rotation.z,  0.06, 0.04);

      } else if (tracked) {
        // ── HEAD MIRRORING: face tracking drives neck + head ──────────────
        // Pitch comes from facial transformation matrix, modified by emotion
        let pitchOffset = 0;
        let rollOffset  = 0;
        if (emotionMode === 'angry') pitchOffset =  0.08;
        if (emotionMode === 'sad')   pitchOffset =  0.18;

        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.12);
        neck.rotation.y = lp(neck.rotation.y, T.headYaw   * 0.45,               0.12);
        neck.rotation.z = lp(neck.rotation.z, T.headRoll  * 0.40 + rollOffset,  0.12);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.14);
        head.rotation.y = lp(head.rotation.y, T.headYaw   * 0.55,               0.14);
        head.rotation.z = lp(head.rotation.z, T.headRoll  * 0.60,               0.14);

        // Bored: override with look-away when very still
        if (T.isBored) {
          if (now > boredLookTimer.current) {
            boredLookYaw.current  = (Math.random() - 0.5) * 0.55;
            boredLookTimer.current = now + 5.0 + Math.random() * 5.0;
          }
          const bsway = Math.sin(boredSwayPh.current) * 0.025;
          head.rotation.y = lp(head.rotation.y,
            boredLookYaw.current + bsway, 0.015);
          head.rotation.z = lp(head.rotation.z,
            boredLookYaw.current * 0.15 + bsway * 0.4, 0.012);
        }

      } else if (headReact && emotionMode === 'angry') {
        // ── ANGRY shout reaction ──────────────────────────────────────────
        jitP.current += delta * 32;
        neck.rotation.x = lp(neck.rotation.x,  0.18, 0.14);
        neck.rotation.z = lp(neck.rotation.z, -0.08, 0.12);
        head.rotation.x = lp(head.rotation.x,  0.14, 0.14);
        head.rotation.z  = Math.sin(jitP.current) * 0.045;

      } else if (emotionMode === 'angry' && isSpeaking) {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.10, 0.08);
        neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        head.rotation.x = lp(head.rotation.x, 0.08, 0.08);
        head.rotation.z = lp(head.rotation.z, 0, 0.06);
        head.rotation.y = lp(head.rotation.y, 0, 0.06);

      } else if (emotionMode === 'sad') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.20, 0.04);
        neck.rotation.z = lp(neck.rotation.z, 0.06, 0.03);
        head.rotation.x = lp(head.rotation.x, 0.10, 0.04);
        head.rotation.y = lp(head.rotation.y, 0, 0.04);
        head.rotation.z = lp(head.rotation.z, 0.04, 0.03);

      } else if (emotionMode === 'happy') {
        jitP.current = 0;
        const sway = Math.sin(swP.current * 1.4) * 0.030;
        neck.rotation.z  = lp(neck.rotation.z, sway, 0.04);
        neck.rotation.x  = lp(neck.rotation.x, -0.02, 0.04);
        head.rotation.z  = lp(head.rotation.z, sway * 1.2, 0.05);
        head.rotation.x  = lp(head.rotation.x, -0.02, 0.04);
        head.rotation.y  = lp(head.rotation.y, Math.sin(swP.current * 0.8) * 0.020, 0.04);

      } else if (isSpeaking) {
        jitP.current = 0;
        const jaw = curExpr.current.aa;
        const spk = Math.sin(now * 3.5) * jaw * 0.04;
        neck.rotation.x = lp(neck.rotation.x, -jaw * 0.04, 0.06);
        neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        head.rotation.x = lp(head.rotation.x, -jaw * 0.06 + spk, 0.08);
        head.rotation.y = lp(head.rotation.y, 0, 0.06);
        head.rotation.z = lp(head.rotation.z, 0, 0.06);

      } else {
        // ── IDLE (no tracking, not speaking, neutral) ────────────────────────────
        // Breathing: ~4 s/cycle sin(t×1.57), amplitude 0.004 rad on neck/head X
        jitP.current = 0;
        const s    = swP.current;
        const amp  = 0.012;
        const brth = Math.sin(now * 1.57) * 0.004;   // subtle idle breath
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp + brth,       0.025);
        neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5,        0.025);
        head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2 - brth * 0.5, 0.030);
        head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7,        0.030);
        head.rotation.z = lp(head.rotation.z, Math.sin(s)        * amp * 0.35,       0.030);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 3 cont. ── ARM / SHOULDER overrides
    // ══════════════════════════════════════════════════════════════════════
    // We use Normalized bones here so we don't fight the raw skeleton
    const rUA = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rSh = h.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = h.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rHd = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

    // THE MAGIC CONSTANTS: We define "Arms down" and apply it to EVERY state.
    const R_DOWN = -1.25;
    const L_DOWN = 1.25;

    if ((tracked && (T.handToMouth || T.isGiggling)) || behaviorMode === 'shyGiggle') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.10, 0.10); rSh.rotation.x = lp(rSh.rotation.x, 0.05, 0.10); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.50, 0.14); rUA.rotation.z = lp(rUA.rotation.z, -0.55, 0.14); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.00, 0.12); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.20, 0.10); rHd.rotation.z = lp(rHd.rotation.z, 0.15, 0.10); }

      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }

    } else if (behaviorMode === 'guilty') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.12, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.15, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.12, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.15, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.25, 0.05); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN - 0.25, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.20, 0.05); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN + 0.25, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0.10, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0.10, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }

    } else if (behaviorMode === 'loudLaugh') {
      const b1 = Math.sin(now * 4.5) * 0.10;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.25, 0.07); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN - 0.35 + b1, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.20, 0.07); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN + 0.30 - b1, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.06); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.06); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.06); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.06); }

    } else if (emotionMode === 'sad') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.18, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.12, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.18, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.12, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.10, 0.04); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN - 0.08, 0.04); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.10, 0.04); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN + 0.08, 0.04); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }

    } else if (isSpeaking) {
      const intensity = emotionMode === 'angry' ? 1.4 : emotionMode === 'happy' ? 1.2 : 1.0;
      const b1 = Math.sin(now * 3.2) * 0.14 * intensity;
      const b2 = Math.sin(now * 3.2 + Math.PI * .5) * 0.11 * intensity;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.45 * intensity, 0.10); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN - 0.22 * intensity, 0.10); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1, 0.13); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.28 * intensity, 0.09); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN + 0.16 * intensity, 0.09); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2, 0.11); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.08); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.08); }

    } else {
      // IDLE REST
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.05); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.05); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.07); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.07); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.07); }
    }
    // ══════════════════════════════════════════════════════════════════════
    // MODULE 3: FACE & EYE DYNAMICS  (post-bone pass — stacks on top of lerp targets)
    // ══════════════════════════════════════════════════════════════════════
    if (head) {
      // A️⃣  LoudLaugh vibration — incommensurable high-freq position noise
      //     Three axes at different frequencies (22 / 30 / 17 Hz) so the jitter
      //     is never periodic and feels genuinely organic.
      if (behaviorMode === 'loudLaugh') {
        const vA = 0.004;
        head.position.x = Math.sin(now * 22.0)             * vA;
        head.position.y = Math.sin(now * 30.1)             * vA * 0.60;
        head.position.z = Math.sin(now * 17.3)             * vA * 0.50;
      } else {
        // Lerp back to zero so behavior transitions don't leave a stuck offset
        head.position.x = lp(head.position.x, 0, 0.30);
        head.position.y = lp(head.position.y, 0, 0.30);
        head.position.z = lp(head.position.z, 0, 0.30);
      }

      // B️⃣  Angry Z-shake — rapid rattle ~19 Hz, amplitude 0.022 rad (≈1.3°/side)
      //     Applied additively on top of whatever pose Module 2D already set.
      if (behaviorMode === 'angry') {
        head.rotation.z += Math.sin(now * 19.0) * 0.022;
      }
    }
    // headVibDecay is used only to hold the ref; actual decay handled via position lerp above
    headVibDecay.current.set(head?.position.x ?? 0, head?.position.y ?? 0, head?.position.z ?? 0);
    // ── VRM physics + lookAt ────────────────────────────────────────────────
    vrm.update(delta);
  });

  return <group ref={groupRef} position={[0, -1.55, 0]} />;
}

// ─── loading spinner ───────────────────────────────────────────────────────────
function LoadingSpinner() {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame((_, d) => { ref.current.rotation.x += d * 1.2; ref.current.rotation.y += d * 0.8; });
  return (
    <mesh ref={ref}>
      <torusGeometry args={[0.5, 0.1, 16, 60]} />
      <meshStandardMaterial color="#6366f1" wireframe />
    </mesh>
  );
}

// ─── synth builder ─────────────────────────────────────────────────────────────
function buildSynth(
  ctx: AudioContext, analyser: AnalyserNode,
  freqs: number[], gains: number[], types: OscillatorType[],
  masterGain: number, lfoFreq: number, lfoGain: number,
): AudioNode[] {
  const nodes: AudioNode[] = [];
  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  nodes.push(master);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = lfoFreq;
  const lg = ctx.createGain();
  lg.gain.value = lfoGain;
  lfo.connect(lg); lg.connect(master.gain); lfo.start();
  nodes.push(lfo, lg);
  for (let i = 0; i < freqs.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = types[i] ?? 'sawtooth';
    osc.frequency.value = freqs[i] + (Math.random() - 0.5) * 3;
    const g = ctx.createGain();
    g.gain.value = gains[i];
    osc.connect(g); g.connect(master); osc.start();
    nodes.push(osc, g);
  }
  return nodes;
}

// ─── tracking status badge helpers ────────────────────────────────────────────
const TRACK_BADGE: Record<string, { label: string; cls: string }> = {
  idle:    { label: '📷 Camera Off',   cls: 'text-slate-400  bg-slate-400/10  border-slate-400/30'   },
  loading: { label: '⏳ Loading MP…',  cls: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/40'  },
  ready:   { label: '📷 Camera Ready', cls: 'text-teal-400   bg-teal-400/10   border-teal-400/40'    },
  active:  { label: '🟢 Face Tracking',cls: 'text-lime-400   bg-lime-400/10   border-lime-400/40 animate-pulse' },
  error:   { label: '❌ Track Error',  cls: 'text-rose-400   bg-rose-400/10   border-rose-400/40'    },
};

// ─── AvatarInterviewer ─────────────────────────────────────────────────────────
type AudioMode = 'off' | 'mic' | 'synth' | 'angry' | 'happy' | 'sad';

const EMOTION_LABELS: Record<EmotionMode, string> = {
  neutral: '😐 Neutral', angry: '😡 Angry', happy: '😊 Happy', sad: '😢 Sad',
};

const BEHAVIOR_LABELS: Record<BehaviorMode, string> = {
  neutral:   '😐 Neutral',
  loudLaugh: '😂 Loud Laugh',
  shyGiggle: '🙈 Shy Giggle',
  guilty:    '😔 Guilty',
  angry:     '😡 Angry',
  blush:     '☺️ Blush',
};

const BEHAVIOR_COLOR: Record<BehaviorMode, BtnColor> = {
  neutral:   'violet',
  loudLaugh: 'amber',
  shyGiggle: 'sky',
  guilty:    'rose',
  angry:     'rose',
  blush:     'lime',
};

export default function AvatarInterviewer() {
  const [audioMode,    setAudioMode]    = useState<AudioMode>('off');
  const [emotionMode,  setEmotionMode]  = useState<EmotionMode>('neutral');
  const [behaviorMode, setBehaviorMode] = useState<BehaviorMode>('neutral');
  const [isNodding,    setIsNodding]    = useState(false);
  const [isShaking,    setIsShaking]    = useState(false);
  const [audioError,   setAudioError]   = useState<string | null>(null);
  const [showCamera,      setShowCamera]      = useState(false);
  const [inputText,       setInputText]       = useState('Hello! I am your AI interviewer.');
  const [isSpeakingText,  setIsSpeakingText]  = useState(false);

  // MediaPipe tracking hook
  const { videoRef, trackingRef, status: trackStatus, statusMsg: trackMsg,
    startTracking, stopTracking } = useMediaPipeTracking();

  const ctxRef        = useRef<AudioContext | null>(null);
  const analyserRef   = useRef<AnalyserNode | null>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const micSrcRef     = useRef<MediaStreamAudioSourceNode | null>(null);
  const synthNodesRef = useRef<AudioNode[]>([]);

  const ensureCtx = useCallback((): { ctx: AudioContext; analyser: AnalyserNode } => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      const ctx      = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize               = 2048;
      analyser.smoothingTimeConstant = 0.5;
      ctxRef.current      = ctx;
      analyserRef.current = analyser;
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
    return { ctx: ctxRef.current, analyser: analyserRef.current! };
  }, []);

  const stopAll = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    micSrcRef.current?.disconnect(); micSrcRef.current = null;
    for (const n of synthNodesRef.current) {
      try { (n as OscillatorNode).stop?.(); n.disconnect(); } catch { /* ok */ }
    }
    synthNodesRef.current = [];
  }, []);

  const handleMic = useCallback(async () => {
    setAudioError(null); stopAll();
    try {
      const { ctx, analyser } = ensureCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src    = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      streamRef.current = stream;
      micSrcRef.current = src;
      setAudioMode('mic');
    } catch { setAudioError('Microphone access denied.'); }
  }, [ensureCtx, stopAll]);

  const handleSynth = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [145, 290, 580, 870, 1160], [0.35, 0.25, 0.18, 0.10, 0.07],
      ['sawtooth','sawtooth','sawtooth','sawtooth','sawtooth'], 0.50, 3.2, 0.45);
    setAudioMode('synth'); setEmotionMode('neutral');
  }, [ensureCtx, stopAll]);

  const handleAngryTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [110, 156, 233, 349], [0.40, 0.30, 0.22, 0.15],
      ['square','square','square','square'], 0.92, 5.5, 0.20);
    setAudioMode('angry'); setEmotionMode('angry');
  }, [ensureCtx, stopAll]);

  const handleHappyTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [440, 880, 1320, 2200, 3300], [0.40, 0.30, 0.22, 0.15, 0.10],
      ['triangle','sine','triangle','sine','sine'], 0.16, 2.2, 0.06);
    setAudioMode('happy'); setEmotionMode('happy');
  }, [ensureCtx, stopAll]);

  const handleSadTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [80, 160, 240, 320], [0.28, 0.20, 0.14, 0.08],
      ['sine','sine','triangle','sine'], 0.13, 1.2, 0.04);
    setAudioMode('sad'); setEmotionMode('sad');
  }, [ensureCtx, stopAll]);

  const handleStop  = useCallback(() => { stopAll(); setAudioMode('off'); }, [stopAll]);

  // ── TEXT TO SPEECH (TTS) ──────────────────────────────────────────────────
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const handleTTS = useCallback(() => {
    if (!inputText.trim()) return;
    setAudioError(null); stopAll();
    if (ttsAudioRef.current) { ttsAudioRef.current.pause(); ttsAudioRef.current = null; }
    const { ctx, analyser } = ensureCtx();
    // StreamElements TTS — free, no CORS issues
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(inputText)}`;
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    ttsAudioRef.current = audio;

    audio.onplay = () => {
      const src = ctx.createMediaElementSource(audio);
      src.connect(analyser);
      analyser.connect(ctx.destination);
      synthNodesRef.current.push(src as unknown as AudioNode);
      setAudioMode('synth');
      setIsSpeakingText(true);
    };

    audio.onended = () => {
      setIsSpeakingText(false);
      setAudioMode('off');
      stopAll();
    };

    audio.onerror = () => {
      setAudioError('TTS failed to load. Check internet connection.');
      setIsSpeakingText(false);
    };

    audio.play().catch(() => setAudioError('Click the screen first to allow audio.'));
  }, [inputText, ensureCtx, stopAll]);

  const handleNod   = useCallback(() => { if (!isNodding) setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking) setIsShaking(true);  }, [isShaking]);
  const onNodEnd    = useCallback(() => setIsNodding(false),  []);
  const onShakeEnd  = useCallback(() => setIsShaking(false), []);

  useEffect(() => () => { stopAll(); ctxRef.current?.close(); }, [stopAll]);

  const BADGE: Record<AudioMode, { label: string; cls: string } | null> = {
    off:   null,
    mic:   { label: '🎤 Mic Active',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' },
    synth: { label: '🔊 Neutral Voice', cls: 'text-violet-400  bg-violet-400/10  border-violet-400/40'  },
    angry: { label: '😡 Angry Voice',   cls: 'text-rose-400    bg-rose-400/10    border-rose-400/40'    },
    happy: { label: '😊 Happy Voice',   cls: 'text-yellow-400  bg-yellow-400/10  border-yellow-400/40'  },
    sad:   { label: '😢 Sad Voice',     cls: 'text-blue-400    bg-blue-400/10    border-blue-400/40'    },
  };
  const audioBadge   = BADGE[audioMode];
  const trackBadge   = TRACK_BADGE[trackStatus];
  const isTrackActive = trackStatus === 'active';

  return (
    <div className="flex flex-col w-full h-full bg-gradient-to-br from-[#0f0f1a] to-[#1a1a2e]">

      {/* Hidden video element for MediaPipe — lives here for DOM mounting only */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute w-0 h-0 opacity-0 pointer-events-none"
        aria-hidden="true"
      />

      {/* 3-D canvas */}
      <div className="flex-1 relative">
        <Canvas camera={{ position: [0, 0.25, 2.4], fov: 38 }} style={{ background: 'transparent' }}>
          <ambientLight intensity={1.1} />
          <directionalLight position={[2, 5, 3]}  intensity={1.8} castShadow />
          <directionalLight position={[-2, 2, -2]} intensity={0.6} color="#aabbff" />
          <Suspense fallback={<LoadingSpinner />}>
            <VRMAvatarMesh
              analyserRef={analyserRef}
              trackingRef={trackingRef}
              emotionMode={emotionMode}
              behaviorMode={behaviorMode}
              isNodding={isNodding}
              isShaking={isShaking}
              onNodEnd={onNodEnd}
              onShakeEnd={onShakeEnd}
            />
          </Suspense>
          <OrbitControls target={[0, 0.1, 0]} minDistance={0.8} maxDistance={6} enablePan={false} />
        </Canvas>

        {/* Top-right: audio badge */}
        {audioBadge && (
          <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${audioBadge.cls}`}>
            <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
            {audioBadge.label}
          </div>
        )}

        {/* Top-left: emotion mode */}
        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border text-slate-300 bg-white/5 border-white/10">
          {EMOTION_LABELS[emotionMode]}
        </div>

        {/* Below emotion badge: tracking status */}
        <div className={`absolute top-14 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${trackBadge.cls}`}>
          {trackBadge.label}
          {trackMsg && <span className="text-[10px] opacity-70 ml-1">— {trackMsg}</span>}
        </div>

        {/* Bored indicator */}
        {isTrackActive && trackingRef.current.isBored && (
          <div className="absolute bottom-14 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] text-slate-400 bg-slate-800/60 border border-slate-700/50">
            😴 Bored idle active
          </div>
        )}

        {/* PiP live camera preview — bottom-right of canvas */}
        {showCamera && isTrackActive && (
          <div className="absolute bottom-4 right-4 group">
            {/* Mirror the feed so it feels natural (like a selfie camera) */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={node => {
                // Mount the same MediaPipe stream into this visible clone
                if (node && videoRef.current?.srcObject) {
                  node.srcObject = videoRef.current.srcObject;
                  node.play().catch(() => {});
                }
              }}
              playsInline
              muted
              autoPlay
              className="w-36 h-auto rounded-2xl border-2 border-white/20 shadow-2xl object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
            <button
              onClick={() => setShowCamera(false)}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Hide camera"
            >✕</button>
          </div>
        )}
      </div>

      {/* controls panel */}
      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-3">

        {audioError && <p className="text-rose-400 text-xs text-center">{audioError}</p>}

        {/* ── Behavior selector ── */}
        <div className="flex flex-col items-center gap-2">
          <span className="text-slate-500 text-[10px] uppercase tracking-widest">Behavior</span>
          <div className="flex flex-wrap justify-center gap-1.5">
            {(Object.keys(BEHAVIOR_LABELS) as BehaviorMode[]).map(k => (
              <CtrlBtn
                key={k}
                onClick={() => setBehaviorMode(k)}
                active={behaviorMode === k}
                color={BEHAVIOR_COLOR[k]}
              >
                {BEHAVIOR_LABELS[k]}
              </CtrlBtn>
            ))}
          </div>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Emotion dropdown ── */}
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <span className="text-slate-400 text-xs">Emotion:</span>
          <select
            value={emotionMode}
            onChange={e => setEmotionMode(e.target.value as EmotionMode)}
            className="bg-white/5 border border-white/15 text-slate-200 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-violet-400 cursor-pointer"
          >
            {(Object.keys(EMOTION_LABELS) as EmotionMode[]).map(k => (
              <option key={k} value={k}>{EMOTION_LABELS[k]}</option>
            ))}
          </select>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Text-To-Speech (TTS) ── */}
        <div className="flex flex-col items-center gap-2 w-full max-w-md">
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTTS()}
            placeholder="Type a sentence here..."
            className="w-full bg-black/40 border border-white/20 text-white text-xs rounded-lg px-3 py-2 outline-none focus:border-sky-400"
          />
          <CtrlBtn onClick={handleTTS} active={isSpeakingText} color="sky">
            🗣️ Speak Text
          </CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Face Tracking ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn
            onClick={isTrackActive ? stopTracking : startTracking}
            active={isTrackActive}
            color="lime"
          >
            {isTrackActive ? '🟢 Stop Tracking' : '📷 Start Face Tracking'}
          </CtrlBtn>
          {isTrackActive && (
            <CtrlBtn
              onClick={() => setShowCamera(v => !v)}
              active={showCamera}
              color="sky"
            >
              {showCamera ? '📹 Hide Camera' : '📹 Show Me'}
            </CtrlBtn>
          )}
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Audio ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleMic}  active={audioMode==='mic'}  color="emerald">🎤 Mic</CtrlBtn>
          <CtrlBtn onClick={handleStop} active={false} color="rose" disabled={audioMode==='off'}>⏹ Stop Audio</CtrlBtn>
        </div>

        {/* ── Synth tests ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleSynth}     active={audioMode==='synth'} color="violet">🔊 Normal</CtrlBtn>
          <CtrlBtn onClick={handleAngryTest} active={audioMode==='angry'} color="rose"  >😡 Angry</CtrlBtn>
          <CtrlBtn onClick={handleHappyTest} active={audioMode==='happy'} color="amber" >😊 Happy</CtrlBtn>
          <CtrlBtn onClick={handleSadTest}   active={audioMode==='sad'}   color="sky"   >😢 Sad</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Head triggers ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleNod}   active={isNodding} color="sky"   disabled={isNodding} >👍 Nod</CtrlBtn>
          <CtrlBtn onClick={handleShake} active={isShaking} color="amber" disabled={isShaking} >👎 Shake</CtrlBtn>
        </div>

        <p className="text-slate-600 text-[10px] text-center leading-relaxed">
          Face Tracking ON: blendshapes → expressions · head pose → neck bones · hand-to-mouth → arm IK · bored idle · giggle
        </p>
      </div>
    </div>
  );
}

// ─── reusable button ───────────────────────────────────────────────────────────
type BtnColor = 'emerald' | 'violet' | 'rose' | 'sky' | 'amber' | 'lime';
const CM: Record<BtnColor, { idle: string; active: string }> = {
  emerald: { idle: 'from-emerald-600 to-teal-600   shadow-emerald-500/25 hover:shadow-emerald-500/45', active: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/40' },
  violet:  { idle: 'from-indigo-500  to-violet-500  shadow-indigo-500/25  hover:shadow-indigo-500/45',  active: 'bg-violet-400/10  text-violet-400  border border-violet-400/40'  },
  rose:    { idle: 'from-rose-600    to-pink-600    shadow-rose-500/25    hover:shadow-rose-500/45',    active: 'bg-rose-400/10    text-rose-400    border border-rose-400/40'    },
  sky:     { idle: 'from-sky-500     to-cyan-500    shadow-sky-500/25     hover:shadow-sky-500/45',     active: 'bg-sky-400/10     text-sky-400     border border-sky-400/40'     },
  amber:   { idle: 'from-amber-500   to-orange-500  shadow-amber-500/25   hover:shadow-amber-500/45',   active: 'bg-amber-400/10   text-amber-400   border border-amber-400/40'   },
  lime:    { idle: 'from-lime-500    to-green-500   shadow-lime-500/25    hover:shadow-lime-500/45',    active: 'bg-lime-400/10    text-lime-400    border border-lime-400/40'    },
};
interface BtnProps { onClick:()=>void; active:boolean; color:BtnColor; disabled?:boolean; children:React.ReactNode }
function CtrlBtn({ onClick, active, color, disabled=false, children }: BtnProps) {
  const c = CM[color];
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-4 py-2 rounded-xl font-semibold text-xs tracking-wide transition-all duration-200
        ${active   ? c.active
        : disabled ? 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500 border border-white/10'
                   : `bg-gradient-to-r ${c.idle} text-white shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer`}`}>
      {children}
    </button>
  );
}
