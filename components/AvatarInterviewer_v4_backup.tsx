/**
 * AvatarInterviewer.tsx  — v4
 *
 * Features:
 *  • EMOTION_PROFILES  (neutral / angry / happy / sad)
 *    – per-profile lip-sync multiplier
 *    – per-profile secondary expression targets
 *    – per-profile head & arm bone dynamics
 *  • Micro-jitter eye lookAt  (eyes never perfectly still)
 *  • Full A-E-I-O-U lip-sync weighted by emotion
 *  • Dropdown emotion selector (ML-ready: swap for auto-detect later)
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

// ─── constants ───────────────────────────────────────────────────────────────
const AVATAR_URL    = '/Anurag.vrm';
const SILENCE_RMS   = 0.015;
const SHOUT_RMS     = 0.10;
const BAND_AMP      = 2.4;

// ─── types ───────────────────────────────────────────────────────────────────
export type EmotionMode = 'neutral' | 'angry' | 'happy' | 'sad';

// All VRM expression preset names we may drive
type EK = 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'blink' | 'angry' | 'happy' | 'sad' | 'relaxed';

// ─── EMOTION PROFILES ────────────────────────────────────────────────────────
interface EmotionProfile {
  /** Overall lip-sync amplitude multiplier */
  lipMult:   number;
  /** Viseme priority weights — how much each vowel is boosted or dampened */
  viseme: { aa: number; ee: number; ih: number; oh: number; ou: number };
  /** Secondary expressions that are always pushed toward target while in this mode */
  secondary: Partial<Record<EK, number>>;
  /** lerp alpha overrides for select expressions (faster = snappier) */
  alphaOverride?: Partial<Record<EK, number>>;
  /** RMS threshold above which the emotion's head reaction triggers */
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
    // angry → sharp, front-of-mouth consonants  (ih/ee boosted)
    viseme:  { aa:1.20, ee:1.50, ih:1.60, oh:0.60, ou:0.40 },
    secondary: { angry: 0.90 },
    alphaOverride: { aa: 0.40, ee: 0.35, ih: 0.38 },   // faster jaw snap
    headReactThreshold: SHOUT_RMS * 0.6,               // triggers at lower volume
  },
  happy: {
    lipMult: 1.10,
    // happy → open bright vowels (aa/ee)
    viseme:  { aa:1.30, ee:1.40, ih:0.80, oh:0.80, ou:0.60 },
    secondary: { happy: 0.75, relaxed: 0.20 },
    headReactThreshold: SHOUT_RMS * 1.5,               // needs really loud to trigger
  },
  sad: {
    // sad → soft, back-of-mouth vowels; 40 % range reduction
    lipMult: 0.60,
    viseme:  { aa:0.60, ee:0.40, ih:0.40, oh:1.20, ou:1.40 },
    secondary: { sad: 0.80, relaxed: 0.10 },
    alphaOverride: { aa: 0.14, oh: 0.18, ou: 0.16 },   // slower, droopy
    headReactThreshold: 9999,                           // no angry reaction when sad
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────
function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += data[i];
  return Math.min(s / (hi - lo) / 255, 1);
}
const lp = THREE.MathUtils.lerp;
const cl = THREE.MathUtils.clamp;

// ─── VRMAvatarMesh ────────────────────────────────────────────────────────────
interface MeshProps {
  analyserRef:  React.RefObject<AnalyserNode | null>;
  emotionMode:  EmotionMode;
  isNodding:    boolean;
  isShaking:    boolean;
  onNodEnd:     () => void;
  onShakeEnd:   () => void;
}

function VRMAvatarMesh({
  analyserRef, emotionMode,
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
    aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0,
  });

  // blink clock
  const nextBlink = useRef(0);
  const blinkT    = useRef(-1);

  // idle sway Phase
  const swP = useRef(Math.random() * Math.PI * 2);

  // nod / shake guards
  const nodT      = useRef(0);
  const shakeT    = useRef(0);
  const nodDone   = useRef(false);
  const shakeDone = useRef(false);
  const prevNod   = useRef(false);
  const prevShake = useRef(false);

  // angry/emotion jitter oscillator
  const jitP = useRef(0);

  // ── micro-jitter lookAt offset ─────────────────────────────────────────
  // A dummy Object3D whose position we nudge slightly every few seconds so
  // the eyes are never perfectly locked forward.
  const jitterObj   = useRef(new THREE.Object3D());
  const jitterGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const jitterNextT = useRef(0);

  // ── load VRM ───────────────────────────────────────────────────────────
  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));

    loader.load(
      AVATAR_URL,
      gltf => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) { console.error('[VRM] no vrm in userData'); return; }

        // Micro-jitter: point lookAt at a dummy Object3D whose position
        // we nudge a little each frame so eyes are never perfectly still.
        vrm.lookAt.target = jitterObj.current;

        groupRef.current.add(vrm.scene);
        vrmRef.current = vrm;

        console.groupCollapsed('[VRM] humanoid bones');
        for (const name of Object.values(VRMHumanBoneName)) {
          const raw  = vrm.humanoid.getRawBoneNode(name);
          const norm = vrm.humanoid.getNormalizedBoneNode(name);
          if (raw || norm) console.log(name, { raw: raw?.name, norm: norm?.name });
        }
        console.groupEnd();

        console.groupCollapsed('[VRM] expressions');
        // @ts-ignore
        for (const k of Object.keys(vrm.expressionManager?.expressionMap ?? {})) console.log(k);
        console.groupEnd();
      },
      undefined,
      err => console.error('[VRM] load error', err),
    );

    return () => {
      if (vrmRef.current) {
        groupRef.current?.remove(vrmRef.current.scene);
        vrmRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setExpr(name: EK, v: number) {
    vrmRef.current?.expressionManager?.setValue(name as VRMExpressionPresetName, v);
  }

  // ── per-frame ──────────────────────────────────────────────────────────
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const now     = state.clock.elapsedTime;
    const profile = EMOTION_PROFILES[emotionMode];
    swP.current  += delta * 0.28;

    // ════════════════════════════════════════════════════════════════════
    // 0. MICRO-JITTER  (eyes dart within ±3 mm every 2-4 s)
    // ════════════════════════════════════════════════════════════════════
    if (now >= jitterNextT.current) {
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      jitterGoal.current.set(
        camPos.x + (Math.random() - 0.5) * 0.06,
        camPos.y + (Math.random() - 0.5) * 0.04,
        camPos.z,
      );
      jitterNextT.current = now + 2.0 + Math.random() * 2.0;
    }
    // Smoothly move the dummy Object3D toward the jitter goal
    jitterObj.current.position.lerp(jitterGoal.current, delta * 6.0);

    // ════════════════════════════════════════════════════════════════════
    // 1. AUDIO  →  expression targets
    // ════════════════════════════════════════════════════════════════════
    const tgt: Record<EK, number> = {
      aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0,
    };

    // Apply profile secondary expressions as baseline
    for (const [k, v] of Object.entries(profile.secondary)) {
      tgt[k as EK] = v as number;
    }

    let isSpeaking = false;
    let headReact  = false;

    const analyser = analyserRef.current;
    if (analyser) {
      if (!freqBuf.current) freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuf.current) timeBuf.current  = new Uint8Array(analyser.fftSize);

      // time-domain RMS
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

        const rL = bandAvg(freqBuf.current, 0,   t);
        const rM = bandAvg(freqBuf.current, t,   t * 2);
        const rH = bandAvg(freqBuf.current, t*2, N);

        // proportional volume
        const vol = Math.pow(cl(sRms.current / 0.12, 0, 1), 0.70);

        const low  = cl(rL * BAND_AMP, 0, 1);
        const mid  = cl(rM * BAND_AMP, 0, 1);
        const high = cl(rH * BAND_AMP, 0, 1);
        const pv   = profile.viseme;
        const lm   = profile.lipMult;

        // A-E-I-O-U  weighted by emotion profile
        tgt.aa = cl(mid  * vol * 1.40 * pv.aa * lm, 0, 1);
        tgt.ee = cl(mid  * vol * 0.75 * pv.ee * lm, 0, 1);
        tgt.ih = cl(high * vol * 1.10 * pv.ih * lm, 0, 1);
        tgt.oh = cl(low  * vol * 1.10 * pv.oh * lm, 0, 1);
        tgt.ou = cl(low  * Math.max(0, 0.45 - tgt.aa) * vol * 1.60 * pv.ou * lm, 0, 1);

        // Secondary expressions: blend toward profile targets while speaking
        for (const [k, v] of Object.entries(profile.secondary)) {
          tgt[k as EK] = cl((v as number) * (0.6 + vol * 0.4), 0, 1);
        }

        // Happy: also driven by brightness
        if (emotionMode === 'happy') tgt.happy = cl(high * vol * 1.10 + 0.6, 0, 1);

        // Angry head-react: push angry expression harder
        if (headReact && emotionMode === 'angry') {
          tgt.angry = 1.0;
          tgt.aa    = cl(tgt.aa * 1.25, 0, 1);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // 2. BLINKS  (every 3-5 s)
    // ════════════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════════════
    // 3. LERP + APPLY EXPRESSIONS
    // ════════════════════════════════════════════════════════════════════
    // Base alphas
    const ALPHA: Record<EK, number> = {
      aa:0.28, ee:0.20, ih:0.20, oh:0.24, ou:0.18,
      blink:0.90, angry:0.18, happy:0.14, sad:0.12, relaxed:0.10,
    };
    // Merge profile alpha overrides
    if (profile.alphaOverride) {
      for (const [k, v] of Object.entries(profile.alphaOverride)) {
        ALPHA[k as EK] = v as number;
      }
    }
    for (const k of Object.keys(tgt) as EK[]) {
      curExpr.current[k] = lp(curExpr.current[k], tgt[k], ALPHA[k]);
      setExpr(k, curExpr.current[k]);
    }
    vrm.expressionManager?.update();

    // ════════════════════════════════════════════════════════════════════
    // 4. BONES  — per-emotion dynamics
    // ════════════════════════════════════════════════════════════════════
    const h    = vrm.humanoid;
    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);

    if (neck && head) {
      if ( isNodding && !prevNod.current)   { nodT.current   = 0; nodDone.current   = false; }
      if ( isShaking && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current   = isNodding;
      prevShake.current = isShaking;

      if (isNodding) {
        // ── NOD (overrides everything) ─────────────────────────────────
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
        // ── SHAKE ────────────────────────────────────────────────────
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

      } else if (headReact && emotionMode === 'angry') {
        // ── ANGRY head-react: tilt forward + intense shake ────────────
        jitP.current += delta * 32;
        neck.rotation.x = lp(neck.rotation.x,  0.18, 0.14);   // lean forward
        neck.rotation.z = lp(neck.rotation.z, -0.08, 0.12);
        head.rotation.x = lp(head.rotation.x,  0.14, 0.14);
        head.rotation.z  = Math.sin(jitP.current) * 0.045;    // shake

      } else if (emotionMode === 'angry' && isSpeaking) {
        // ── ANGRY speaking (no shout): slight forward lean
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.10, 0.08);
        neck.rotation.z = lp(neck.rotation.z, 0,    0.06);
        head.rotation.x = lp(head.rotation.x, 0.08, 0.08);
        head.rotation.z = lp(head.rotation.z, 0,    0.06);
        head.rotation.y = lp(head.rotation.y, 0,    0.06);

      } else if (emotionMode === 'sad') {
        // ── SAD: neck droops down, slight side tilt ───────────────────
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.20, 0.04);   // droop
        neck.rotation.z = lp(neck.rotation.z, 0.06, 0.03);   // tilt
        head.rotation.x = lp(head.rotation.x, 0.10, 0.04);
        head.rotation.y = lp(head.rotation.y, 0,    0.04);
        head.rotation.z = lp(head.rotation.z, 0.04, 0.03);

      } else if (emotionMode === 'happy') {
        // ── HAPPY idle/speaking: gentle side-to-side sway ─────────────
        jitP.current = 0;
        const sway = Math.sin(swP.current * 1.4) * 0.030;    // wide, bouncy
        neck.rotation.z  = lp(neck.rotation.z,  sway,  0.04);
        neck.rotation.x  = lp(neck.rotation.x, -0.02,  0.04);
        head.rotation.z  = lp(head.rotation.z,  sway * 1.2, 0.05);
        head.rotation.x  = lp(head.rotation.x, -0.02,  0.04);
        head.rotation.y  = lp(head.rotation.y,  Math.sin(swP.current * 0.8) * 0.020, 0.04);

      } else if (isSpeaking) {
        // ── NEUTRAL speaking: jaw-coupled micro-movement ──────────────
        jitP.current = 0;
        const jaw = curExpr.current.aa;
        const spk = Math.sin(now * 3.5) * jaw * 0.04;
        neck.rotation.x = lp(neck.rotation.x, -jaw * 0.04, 0.06);
        neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        head.rotation.x = lp(head.rotation.x, -jaw * 0.06 + spk, 0.08);
        head.rotation.y = lp(head.rotation.y, 0, 0.06);
        head.rotation.z = lp(head.rotation.z, 0, 0.06);

      } else {
        // ── IDLE (silent, neutral) ────────────────────────────────────
        jitP.current = 0;
        const s   = swP.current;
        const amp = 0.012;
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp,        0.025);
        neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5,  0.025);
        head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2,  0.030);
        head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7,  0.030);
        head.rotation.z = lp(head.rotation.z, Math.sin(s)        * amp * 0.35, 0.030);
      }
    }

    // ── ARM / SHOULDER DYNAMICS ─────────────────────────────────────────
    const rUA = h.getRawBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getRawBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getRawBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getRawBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rSh = h.getRawBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = h.getRawBoneNode(VRMHumanBoneName.LeftShoulder);

    if (emotionMode === 'sad') {
      // SAD: shoulders slump forward, arms hang heavy
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.18, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.12, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.18, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.12, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.10, 0.04); rUA.rotation.z = lp(rUA.rotation.z, -0.08, 0.04); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.10, 0.04); lUA.rotation.z = lp(lUA.rotation.z,  0.08, 0.04); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.05); }
    } else if (isSpeaking) {
      // SPEAKING: arms gesture; angry version is more intense
      const intensity = emotionMode === 'angry' ? 1.4 : emotionMode === 'happy' ? 1.2 : 1.0;
      const b1 = Math.sin(now * 3.2)               * 0.14 * intensity;
      const b2 = Math.sin(now * 3.2 + Math.PI * .5) * 0.11 * intensity;

      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.45 * intensity, 0.10); rUA.rotation.z = lp(rUA.rotation.z, -0.22 * intensity, 0.10); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1,  0.13); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.28 * intensity, 0.09); lUA.rotation.z = lp(lUA.rotation.z, 0.16 * intensity, 0.09); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2,  0.11); }
    } else {
      // IDLE / rest
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.05); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.05); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.07); rUA.rotation.z = lp(rUA.rotation.z, 0, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 0, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
    }

    // ── VRM physics + lookAt tick ──────────────────────────────────────
    vrm.update(delta);
  });

  return <group ref={groupRef} position={[0, -1.55, 0]} />;
}

// ─── loading spinner ──────────────────────────────────────────────────────────
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

// ─── synth builder ────────────────────────────────────────────────────────────
function buildSynth(
  ctx: AudioContext,
  analyser: AnalyserNode,
  freqs: number[],
  gains: number[],
  types: OscillatorType[],
  masterGain: number,
  lfoFreq: number,
  lfoGain: number,
): AudioNode[] {
  const nodes: AudioNode[] = [];
  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  nodes.push(master);

  const lfo  = ctx.createOscillator();
  lfo.type   = 'sine';
  lfo.frequency.value = lfoFreq;
  const lg   = ctx.createGain();
  lg.gain.value = lfoGain;
  lfo.connect(lg);
  lg.connect(master.gain);
  lfo.start();
  nodes.push(lfo, lg);

  for (let i = 0; i < freqs.length; i++) {
    const osc = ctx.createOscillator();
    osc.type  = types[i] ?? 'sawtooth';
    osc.frequency.value = freqs[i] + (Math.random() - 0.5) * 3;
    const g   = ctx.createGain();
    g.gain.value = gains[i];
    osc.connect(g);
    g.connect(master);
    osc.start();
    nodes.push(osc, g);
  }
  return nodes;
}

// ─── AvatarInterviewer ────────────────────────────────────────────────────────
type AudioMode = 'off' | 'mic' | 'synth' | 'angry' | 'happy' | 'sad';

const EMOTION_LABELS: Record<EmotionMode, string> = {
  neutral: '😐 Neutral',
  angry:   '😡 Angry',
  happy:   '😊 Happy',
  sad:     '😢 Sad',
};

export default function AvatarInterviewer() {
  const [audioMode,   setAudioMode]   = useState<AudioMode>('off');
  const [emotionMode, setEmotionMode] = useState<EmotionMode>('neutral');
  const [isNodding,   setIsNodding]   = useState(false);
  const [isShaking,   setIsShaking]   = useState(false);
  const [audioError,  setAudioError]  = useState<string | null>(null);

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
    micSrcRef.current?.disconnect();
    micSrcRef.current = null;
    for (const n of synthNodesRef.current) {
      try { (n as OscillatorNode).stop?.(); n.disconnect(); } catch { /* ok */ }
    }
    synthNodesRef.current = [];
  }, []);

  // ── MIC ──────────────────────────────────────────────────────────────────
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
    } catch {
      setAudioError('Microphone access denied — allow permissions and try again.');
    }
  }, [ensureCtx, stopAll]);

  // ── NEUTRAL SYNTH ─────────────────────────────────────────────────────────
  const handleSynth = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [145, 290, 580, 870, 1160],
      [0.35, 0.25, 0.18, 0.10, 0.07],
      ['sawtooth','sawtooth','sawtooth','sawtooth','sawtooth'],
      0.50, 3.2, 0.45,
    );
    setAudioMode('synth');
    setEmotionMode('neutral');
  }, [ensureCtx, stopAll]);

  // ── ANGRY SYNTH ───────────────────────────────────────────────────────────
  const handleAngryTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [110, 156, 233, 349],
      [0.40, 0.30, 0.22, 0.15],
      ['square','square','square','square'],
      0.92, 5.5, 0.20,
    );
    setAudioMode('angry');
    setEmotionMode('angry');
  }, [ensureCtx, stopAll]);

  // ── HAPPY SYNTH ───────────────────────────────────────────────────────────
  const handleHappyTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [440, 880, 1320, 2200, 3300],
      [0.40, 0.30, 0.22, 0.15, 0.10],
      ['triangle','sine','triangle','sine','sine'],
      0.16, 2.2, 0.06,
    );
    setAudioMode('happy');
    setEmotionMode('happy');
  }, [ensureCtx, stopAll]);

  // ── SAD SYNTH ─────────────────────────────────────────────────────────────
  const handleSadTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(ctx, analyser,
      [80, 160, 240, 320],
      [0.28, 0.20, 0.14, 0.08],
      ['sine','sine','triangle','sine'],
      0.13, 1.2, 0.04,   // very quiet, very slow
    );
    setAudioMode('sad');
    setEmotionMode('sad');
  }, [ensureCtx, stopAll]);

  // ── STOP ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => { stopAll(); setAudioMode('off'); }, [stopAll]);

  const handleNod   = useCallback(() => { if (!isNodding)  setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking)  setIsShaking(true);  }, [isShaking]);
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
  const badge = BADGE[audioMode];

  return (
    <div className="flex flex-col w-full h-full bg-gradient-to-br from-[#0f0f1a] to-[#1a1a2e]">

      {/* 3-D canvas */}
      <div className="flex-1 relative">
        <Canvas camera={{ position: [0, 0.25, 2.4], fov: 38 }} style={{ background: 'transparent' }}>
          <ambientLight intensity={1.1} />
          <directionalLight position={[2, 5, 3]}  intensity={1.8} castShadow />
          <directionalLight position={[-2, 2, -2]} intensity={0.6} color="#aabbff" />

          <Suspense fallback={<LoadingSpinner />}>
            <VRMAvatarMesh
              analyserRef={analyserRef}
              emotionMode={emotionMode}
              isNodding={isNodding}
              isShaking={isShaking}
              onNodEnd={onNodEnd}
              onShakeEnd={onShakeEnd}
            />
          </Suspense>

          <OrbitControls target={[0, 0.1, 0]} minDistance={0.8} maxDistance={6} enablePan={false} />
        </Canvas>

        {badge && (
          <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${badge.cls}`}>
            <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
            {badge.label}
          </div>
        )}

        {/* Emotion mode badge (bottom-left) */}
        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border text-slate-300 bg-white/5 border-white/10">
          {EMOTION_LABELS[emotionMode]}
        </div>

        {audioMode === 'off' && (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-500 pointer-events-none select-none">
            VRM Avatar · Drag to orbit · Scroll to zoom
          </p>
        )}
      </div>

      {/* controls */}
      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-3">

        {audioError && <p className="text-rose-400 text-xs text-center">{audioError}</p>}

        {/* ── Emotion dropdown (ML-ready slot) ── */}
        <div className="flex items-center gap-3">
          <span className="text-slate-400 text-xs">Emotion Mode:</span>
          <select
            value={emotionMode}
            onChange={e => setEmotionMode(e.target.value as EmotionMode)}
            className="bg-white/5 border border-white/15 text-slate-200 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-violet-400 cursor-pointer"
          >
            {(Object.keys(EMOTION_LABELS) as EmotionMode[]).map(k => (
              <option key={k} value={k}>{EMOTION_LABELS[k]}</option>
            ))}
          </select>
          <span className="text-slate-600 text-[10px]">← swap for auto-detect later</span>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Audio row — mic + stop ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleMic}  active={audioMode==='mic'}  color="emerald">🎤 Start Mic</CtrlBtn>
          <CtrlBtn onClick={handleStop} active={false} color="rose" disabled={audioMode==='off'}>⏹ Stop</CtrlBtn>
        </div>

        {/* ── Emotion audio tests ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleSynth}      active={audioMode==='synth'} color="violet">🔊 Normal</CtrlBtn>
          <CtrlBtn onClick={handleAngryTest}  active={audioMode==='angry'} color="rose"  >😡 Angry</CtrlBtn>
          <CtrlBtn onClick={handleHappyTest}  active={audioMode==='happy'} color="amber" >😊 Happy</CtrlBtn>
          <CtrlBtn onClick={handleSadTest}    active={audioMode==='sad'}   color="sky"   >😢 Sad</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* ── Head triggers ── */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleNod}   active={isNodding}  color="sky"   disabled={isNodding} >👍 Nod Yes</CtrlBtn>
          <CtrlBtn onClick={handleShake} active={isShaking}  color="amber" disabled={isShaking} >👎 Shake No</CtrlBtn>
        </div>

        <p className="text-slate-600 text-[10px] text-center leading-relaxed">
          Lip-sync weights · head dynamics · arm slump · eye micro-jitter all driven by Emotion Mode
        </p>
      </div>
    </div>
  );
}

// ─── reusable button ──────────────────────────────────────────────────────────
type BtnColor = 'emerald' | 'violet' | 'rose' | 'sky' | 'amber';
const CM: Record<BtnColor, { idle: string; active: string }> = {
  emerald: { idle: 'from-emerald-600 to-teal-600   shadow-emerald-500/25 hover:shadow-emerald-500/45', active: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/40' },
  violet:  { idle: 'from-indigo-500  to-violet-500  shadow-indigo-500/25  hover:shadow-indigo-500/45',  active: 'bg-violet-400/10  text-violet-400  border border-violet-400/40'  },
  rose:    { idle: 'from-rose-600    to-pink-600    shadow-rose-500/25    hover:shadow-rose-500/45',    active: 'bg-rose-400/10    text-rose-400    border border-rose-400/40'    },
  sky:     { idle: 'from-sky-500     to-cyan-500    shadow-sky-500/25     hover:shadow-sky-500/45',     active: 'bg-sky-400/10     text-sky-400     border border-sky-400/40'     },
  amber:   { idle: 'from-amber-500   to-orange-500  shadow-amber-500/25   hover:shadow-amber-500/45',   active: 'bg-amber-400/10   text-amber-400   border border-amber-400/40'   },
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
