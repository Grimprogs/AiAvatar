/**
 * useVRMPose.ts
 *
 * Manages all bone rotations for the VRM avatar each frame:
 *   • Layer 0 — Spine / Chest breathing sine wave
 *   • Layer 1 — LookAt jitter target (eye micro-saccades / nystagmus)
 *   • Layer 2 — Neck / Head pose:
 *       nod, shake, giggle, behaviour modes, MediaPipe head-tracking,
 *       emotion-driven idle sway, speaking chin-dip, audio angry-react
 *   • Layer 3 — Arm / Shoulder / Hand bones:
 *       handToMouth IK, behaviour poses, speaking gestures, neutral hang
 *   • Additive jitters — head position vibration (loudLaugh), Z-shake (angry)
 *
 * Returns:
 *   tick(delta, now, isSpeaking, headReact, jawOpen) — call once per useFrame,
 *     AFTER face.tick() so isSpeaking / headReact / jawOpen are fresh.
 *   jitterObj — THREE.Object3D used as vrm.lookAt.target; set this on VRM load.
 */
import { useRef, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { TrackingData } from './useMediaPipeTracking';
import type { EmotionMode, BehaviorMode } from './useVRMFace';

// ─── helpers ──────────────────────────────────────────────────────────────────
const lp = THREE.MathUtils.lerp;

// ─── types ────────────────────────────────────────────────────────────────────
interface UseVRMPoseArgs {
  vrmRef:       React.RefObject<VRM | null>;
  trackingRef:  React.RefObject<TrackingData>;
  emotionMode:  EmotionMode;
  behaviorMode: BehaviorMode;
  isNodding:    boolean;
  isShaking:    boolean;
  onNodEnd:     () => void;
  onShakeEnd:   () => void;
}

export interface UseVRMPoseReturn {
  /**
   * Call once per frame after face.tick().
   * @param delta      seconds since last frame (from useFrame)
   * @param now        elapsed clock time (state.clock.elapsedTime)
   * @param isSpeaking from face.tick()
   * @param headReact  from face.tick()
   * @param jawOpen    face.curExpr.current.aa
   */
  tick: (delta: number, now: number, isSpeaking: boolean, headReact: boolean, jawOpen: number) => void;
  /** THREE.Object3D to assign as vrm.lookAt.target on VRM load. */
  jitterObj: React.RefObject<THREE.Object3D>;
}

// ─── hook ─────────────────────────────────────────────────────────────────────
export function useVRMPose({
  vrmRef,
  trackingRef,
  emotionMode,
  behaviorMode,
  isNodding,
  isShaking,
  onNodEnd,
  onShakeEnd,
}: UseVRMPoseArgs): UseVRMPoseReturn {
  // Camera for look-at target positioning
  const { camera } = useThree();

  // ── Phase refs (continuous sine clocks) ──────────────────────────────────
  const swP         = useRef(Math.random() * Math.PI * 2);  // idle sway
  const boredSwayPh = useRef(0);                            // bored drift phase
  const jitP        = useRef(0);                            // behaviour jitter phase

  // ── Nod / shake animation ────────────────────────────────────────────────
  const nodT      = useRef(0);
  const shakeT    = useRef(0);
  const nodDone   = useRef(false);
  const shakeDone = useRef(false);
  const prevNod   = useRef(false);
  const prevShake = useRef(false);

  // ── LookAt jitter (eye target) ───────────────────────────────────────────
  const jitterObj   = useRef<THREE.Object3D>(new THREE.Object3D());
  const jitterGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const jitterNextT = useRef(0);

  // ── Nystagmus (fine rapid saccades for neutral/sad) ──────────────────────
  const nystagmusGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const nystagmusTimer = useRef(0);

  // ── Giggle animation ─────────────────────────────────────────────────────
  const gigglingT   = useRef(-1);
  const prevGiggle  = useRef(false);

  // ── Bored drift ──────────────────────────────────────────────────────────
  const boredLookYaw   = useRef(0);
  const boredLookTimer = useRef(0);

  // ── Stale-closure guard: keep props fresh in refs ────────────────────────
  const emotionRef   = useRef(emotionMode);
  const behaviorRef  = useRef(behaviorMode);
  const isNoddingRef = useRef(isNodding);
  const isShakingRef = useRef(isShaking);
  const onNodEndRef  = useRef(onNodEnd);
  const onShakeEndRef = useRef(onShakeEnd);

  useEffect(() => { emotionRef.current   = emotionMode;   }, [emotionMode]);
  useEffect(() => { behaviorRef.current  = behaviorMode;  }, [behaviorMode]);
  useEffect(() => { isNoddingRef.current = isNodding;     }, [isNodding]);
  useEffect(() => { isShakingRef.current = isShaking;     }, [isShaking]);
  useEffect(() => { onNodEndRef.current  = onNodEnd;      }, [onNodEnd]);
  useEffect(() => { onShakeEndRef.current = onShakeEnd;   }, [onShakeEnd]);

  // ── tick ─────────────────────────────────────────────────────────────────
  function tick(
    delta:      number,
    now:        number,
    isSpeaking: boolean,
    headReact:  boolean,
    jawOpen:    number,
  ): void {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const emotion   = emotionRef.current;
    const behavior  = behaviorRef.current;
    const nodding   = isNoddingRef.current;
    const shaking   = isShakingRef.current;
    const T         = trackingRef.current;
    const tracked   = T.active;
    const h         = vrm.humanoid;

    // ── advance phase clocks ───────────────────────────────────────────────
    swP.current         += delta * 0.28;
    boredSwayPh.current += delta * 0.12;

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 0 — Spine / Chest breathing
    // ─────────────────────────────────────────────────────────────────────
    {
      const BREATH = 0.25 * Math.PI * 2;
      const inhale = Math.sin(now * BREATH);
      const exhale = Math.cos(now * BREATH);
      const BAMP   = 0.005;

      const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
      const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);

      if (spine) {
        spine.rotation.x = lp(spine.rotation.x, -inhale * BAMP * 0.40, 0.05);
        spine.rotation.z = lp(spine.rotation.z,  exhale * BAMP * 0.15, 0.04);
      }
      if (chest) {
        chest.rotation.x = lp(chest.rotation.x, -inhale * BAMP * 0.60, 0.05);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 1 — LookAt target jitter / nystagmus
    // ─────────────────────────────────────────────────────────────────────
    {
      const cp = new THREE.Vector3();
      camera.getWorldPosition(cp);

      const isNystagmus = !tracked && (behavior === 'neutral' || emotion === 'sad');
      const isLazy      = behavior === 'shyGiggle' || behavior === 'blush';

      if (isNystagmus) {
        if (now >= nystagmusTimer.current) {
          nystagmusGoal.current.set(
            cp.x + (Math.random() - 0.5) * 0.070,
            cp.y + (Math.random() - 0.5) * 0.050,
            cp.z,
          );
          nystagmusTimer.current = now + 0.15 + Math.random() * 0.30;
        }
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
        const lookAlpha =
          isLazy          ? delta * 1.8 :
          behavior === 'angry'      ? delta * 9.0 :
          behavior === 'loudLaugh'  ? delta * 3.5 : delta * 6.0;
        jitterObj.current.position.lerp(jitterGoal.current, lookAlpha);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 2 — Neck / Head pose
    // ─────────────────────────────────────────────────────────────────────
    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);

    if (neck && head) {
      // Edge-detect start of nod / shake
      if (nodding  && !prevNod.current)   { nodT.current   = 0; nodDone.current   = false; }
      if (shaking  && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current   = nodding;
      prevShake.current = shaking;

      // Giggle-start edge detect
      if (tracked && T.isGiggling && !prevGiggle.current) gigglingT.current = 0;
      if (!T.isGiggling) gigglingT.current = -1;
      prevGiggle.current = tracked && T.isGiggling;
      if (gigglingT.current >= 0) gigglingT.current += delta;

      if (nodding) {
        // ── Nod animation ──────────────────────────────────────────────
        nodT.current += delta;
        if (nodT.current < 2.0) {
          head.rotation.x = Math.sin(nodT.current * Math.PI * 2.5) * 0.18;
          head.rotation.y = lp(head.rotation.y, 0, 0.08);
          head.rotation.z = lp(head.rotation.z, 0, 0.08);
          neck.rotation.x = lp(neck.rotation.x, 0, 0.06);
          neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        } else {
          head.rotation.x = lp(head.rotation.x, 0, 0.10);
          if (!nodDone.current) { nodDone.current = true; onNodEndRef.current(); }
        }
      } else if (shaking) {
        // ── Head-shake animation ───────────────────────────────────────
        shakeT.current += delta;
        if (shakeT.current < 2.0) {
          head.rotation.y = Math.sin(shakeT.current * Math.PI * 3.5) * 0.18;
          head.rotation.x = lp(head.rotation.x, 0, 0.08);
          head.rotation.z = lp(head.rotation.z, 0, 0.08);
          neck.rotation.x = lp(neck.rotation.x, 0, 0.06);
          neck.rotation.z = lp(neck.rotation.z, 0, 0.06);
        } else {
          head.rotation.y = lp(head.rotation.y, 0, 0.10);
          if (!shakeDone.current) { shakeDone.current = true; onShakeEndRef.current(); }
        }
      } else if (tracked && gigglingT.current >= 0) {
        // ── Giggling bounce ────────────────────────────────────────────
        const gig    = gigglingT.current;
        const bounce = Math.sin(gig * Math.PI * 8.0) * 0.06;
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.5,  0.10);
        neck.rotation.y = lp(neck.rotation.y, T.headYaw   * 0.4,  0.10);
        neck.rotation.z = lp(neck.rotation.z, T.headRoll  * 0.4,  0.10);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.5 + bounce, 0.15);
        head.rotation.y = lp(head.rotation.y, T.headYaw   * 0.6,  0.12);
        head.rotation.z = lp(head.rotation.z, T.headRoll  * 0.6 + 0.15 + Math.sin(gig * 5.0) * 0.04, 0.12);
      } else if (behavior === 'loudLaugh') {
        jitP.current += delta * 1.5;
        neck.rotation.x = lp(neck.rotation.x, -0.32, 0.10);
        neck.rotation.z = lp(neck.rotation.z,  0.00, 0.08);
        head.rotation.x = lp(head.rotation.x, -0.40, 0.10);
        head.rotation.y = lp(head.rotation.y,  Math.sin(jitP.current * 0.8) * 0.12, 0.06);
        head.rotation.z = lp(head.rotation.z,  Math.sin(jitP.current * 1.1) * 0.06, 0.06);
      } else if (behavior === 'shyGiggle') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x,  0.22, 0.08);
        neck.rotation.z = lp(neck.rotation.z,  0.12, 0.06);
        head.rotation.x = lp(head.rotation.x,  0.18 + Math.sin(now * 6.0) * 0.012, 0.08);
        head.rotation.y = lp(head.rotation.y,  0.15, 0.06);
        head.rotation.z = lp(head.rotation.z,  0.10, 0.06);
      } else if (behavior === 'guilty') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x,  0.55, 0.05);
        neck.rotation.z = lp(neck.rotation.z,  0.04, 0.04);
        head.rotation.x = lp(head.rotation.x,  0.60, 0.05);
        head.rotation.y = lp(head.rotation.y,  0,    0.04);
        head.rotation.z = lp(head.rotation.z,  0,    0.04);
      } else if (behavior === 'angry') {
        jitP.current += delta * 28;
        neck.rotation.x = lp(neck.rotation.x, 0.15, 0.12);
        neck.rotation.z = lp(neck.rotation.z, 0,    0.10);
        head.rotation.x = lp(head.rotation.x, 0.10, 0.12);
        head.rotation.y = lp(head.rotation.y, 0,    0.10);
      } else if (behavior === 'blush') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.10, 0.05);
        neck.rotation.z = lp(neck.rotation.z, 0.08, 0.05);
        head.rotation.x = lp(head.rotation.x, 0.08, 0.05);
        head.rotation.y = lp(head.rotation.y, 0,    0.04);
        head.rotation.z = lp(head.rotation.z, 0.06, 0.04);
      } else if (tracked) {
        // ── MediaPipe head-tracking override ───────────────────────────
        const pitchOffset = emotion === 'angry' ? 0.08 : emotion === 'sad' ? 0.18 : 0;
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.12);
        neck.rotation.y = lp(neck.rotation.y, T.headYaw   * 0.45,               0.12);
        neck.rotation.z = lp(neck.rotation.z, T.headRoll  * 0.40,               0.12);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.14);
        head.rotation.y = lp(head.rotation.y, T.headYaw   * 0.55,               0.14);
        head.rotation.z = lp(head.rotation.z, T.headRoll  * 0.60,               0.14);
        if (T.isBored) {
          if (now > boredLookTimer.current) {
            boredLookYaw.current   = (Math.random() - 0.5) * 0.55;
            boredLookTimer.current = now + 5.0 + Math.random() * 5.0;
          }
          const bsway = Math.sin(boredSwayPh.current) * 0.025;
          head.rotation.y = lp(head.rotation.y, boredLookYaw.current + bsway,                   0.015);
          head.rotation.z = lp(head.rotation.z, boredLookYaw.current * 0.15 + bsway * 0.4, 0.012);
        }
      } else if (headReact && emotion === 'angry') {
        // ── Angry head-react vibration ────────────────────────────────
        jitP.current += delta * 32;
        neck.rotation.x = lp(neck.rotation.x,  0.18, 0.14);
        neck.rotation.z = lp(neck.rotation.z, -0.08, 0.12);
        head.rotation.x = lp(head.rotation.x,  0.14, 0.14);
        head.rotation.z  = Math.sin(jitP.current) * 0.045;
      } else if (emotion === 'angry' && isSpeaking) {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.10, 0.08);
        neck.rotation.z = lp(neck.rotation.z, 0,    0.06);
        head.rotation.x = lp(head.rotation.x, 0.08, 0.08);
        head.rotation.z = lp(head.rotation.z, 0,    0.06);
        head.rotation.y = lp(head.rotation.y, 0,    0.06);
      } else if (emotion === 'sad') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.20, 0.04);
        neck.rotation.z = lp(neck.rotation.z, 0.06, 0.03);
        head.rotation.x = lp(head.rotation.x, 0.10, 0.04);
        head.rotation.y = lp(head.rotation.y, 0,    0.04);
        head.rotation.z = lp(head.rotation.z, 0.04, 0.03);
      } else if (emotion === 'happy') {
        jitP.current = 0;
        const sway = Math.sin(swP.current * 1.4) * 0.030;
        neck.rotation.z = lp(neck.rotation.z,  sway,                           0.04);
        neck.rotation.x = lp(neck.rotation.x, -0.02,                           0.04);
        head.rotation.z = lp(head.rotation.z,  sway * 1.2,                     0.05);
        head.rotation.x = lp(head.rotation.x, -0.02,                           0.04);
        head.rotation.y = lp(head.rotation.y,  Math.sin(swP.current * 0.8) * 0.020, 0.04);
      } else if (isSpeaking) {
        // ── Jaw-driven chin-dip while speaking ────────────────────────
        jitP.current = 0;
        const spk = Math.sin(now * 3.5) * jawOpen * 0.04;
        neck.rotation.x = lp(neck.rotation.x, -jawOpen * 0.04, 0.06);
        neck.rotation.z = lp(neck.rotation.z,  0,               0.06);
        head.rotation.x = lp(head.rotation.x, -jawOpen * 0.06 + spk, 0.08);
        head.rotation.y = lp(head.rotation.y,  0,               0.06);
        head.rotation.z = lp(head.rotation.z,  0,               0.06);
      } else {
        // ── Neutral idle sway ─────────────────────────────────────────
        jitP.current = 0;
        const s    = swP.current;
        const amp  = 0.012;
        const brth = Math.sin(now * 1.57) * 0.004;
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp + brth,          0.025);
        neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5,            0.025);
        head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2 - brth * 0.5, 0.030);
        head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7,            0.030);
        head.rotation.z = lp(head.rotation.z, Math.sin(s)        * amp * 0.35,           0.030);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // LAYER 3 — Arm / Shoulder / Hand bones
    // ─────────────────────────────────────────────────────────────────────
    const rUA = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rSh = h.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = h.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rHd = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

    if ((tracked && (T.handToMouth || T.isGiggling)) || behavior === 'shyGiggle') {
      // ── Hand-to-mouth / shy giggle IK ─────────────────────────────────
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.10, 0.10); rSh.rotation.x = lp(rSh.rotation.x,  0.05, 0.10); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.50, 0.14); rUA.rotation.z = lp(rUA.rotation.z, -0.55, 0.14); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.00, 0.12); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.20, 0.10); rHd.rotation.z = lp(rHd.rotation.z,  0.15, 0.10); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0,    0.06); lSh.rotation.x = lp(lSh.rotation.x,  0,    0.06); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x,  0,    0.07); lUA.rotation.z = lp(lUA.rotation.z,  1.25, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x,  0,    0.07); }
    } else if (behavior === 'guilty') {
      // ── Guilty — arms crossed / inward ───────────────────────────────
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.12, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.15, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.12, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.15, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x,  0.25, 0.05); rUA.rotation.z = lp(rUA.rotation.z, -1.50, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x,  0.20, 0.05); lUA.rotation.z = lp(lUA.rotation.z,  1.50, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x,  0.10, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x,  0.10, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x,  0,    0.05); rHd.rotation.z = lp(rHd.rotation.z,  0, 0.05); }
    } else if (behavior === 'loudLaugh') {
      // ── Loud laugh — arms wide + sine bob ────────────────────────────
      const b1 = Math.sin(now * 4.5) * 0.10;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z,  0,    0.06); rSh.rotation.x = lp(rSh.rotation.x,  0,    0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0,    0.06); lSh.rotation.x = lp(lSh.rotation.x,  0,    0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.25, 0.07); rUA.rotation.z = lp(rUA.rotation.z, -1.60 + b1, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.20, 0.07); lUA.rotation.z = lp(lUA.rotation.z,  1.55 - b1, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x,  0,    0.06); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x,  0,    0.06); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x,  0,    0.06); rHd.rotation.z = lp(rHd.rotation.z,  0,    0.06); }
    } else if (emotionMode === 'sad') {
      // ── Sad — slightly drooped shoulders ─────────────────────────────
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.18, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.12, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.18, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.12, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x,  0.10, 0.04); rUA.rotation.z = lp(rUA.rotation.z, -1.33, 0.04); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x,  0.10, 0.04); lUA.rotation.z = lp(lUA.rotation.z,  1.33, 0.04); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x,  0,    0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x,  0,    0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x,  0,    0.05); rHd.rotation.z = lp(rHd.rotation.z,  0,    0.05); }
    } else if (isSpeaking) {
      // ── Speaking gestures (intensity modulated by emotion) ────────────
      const intensity = emotionMode === 'angry' ? 1.4 : emotionMode === 'happy' ? 1.2 : 1.0;
      const b1 = Math.sin(now * 3.2)                  * 0.14 * intensity;
      const b2 = Math.sin(now * 3.2 + Math.PI * 0.5)  * 0.11 * intensity;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z,  0,    0.06); rSh.rotation.x = lp(rSh.rotation.x,  0,    0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0,    0.06); lSh.rotation.x = lp(lSh.rotation.x,  0,    0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.45 * intensity,   0.10); rUA.rotation.z = lp(rUA.rotation.z, -1.47 * intensity, 0.10); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1,          0.13); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.28 * intensity,   0.09); lUA.rotation.z = lp(lUA.rotation.z,  1.41 * intensity, 0.09); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2,          0.11); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x,  0,    0.08); rHd.rotation.z = lp(rHd.rotation.z,  0,    0.08); }
    } else {
      // ── Neutral hang — R_DOWN = -1.25, L_DOWN = 1.25 (no T-Pose) ────
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z,  0,     0.05); rSh.rotation.x = lp(rSh.rotation.x,  0,     0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0,     0.05); lSh.rotation.x = lp(lSh.rotation.x,  0,     0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x,  0,     0.07); rUA.rotation.z = lp(rUA.rotation.z, -1.25,  0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x,  0,     0.07); lUA.rotation.z = lp(lUA.rotation.z,  1.25,  0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x,  0,     0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x,  0,     0.07); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x,  0,     0.07); rHd.rotation.z = lp(rHd.rotation.z,  0,     0.07); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Additive jitters — head position & Z-shake
    // ─────────────────────────────────────────────────────────────────────
    if (head) {
      if (behavior === 'loudLaugh') {
        const vA = 0.004;
        head.position.x = Math.sin(now * 22.0) * vA;
        head.position.y = Math.sin(now * 30.1) * vA * 0.60;
        head.position.z = Math.sin(now * 17.3) * vA * 0.50;
      } else {
        head.position.x = lp(head.position.x, 0, 0.30);
        head.position.y = lp(head.position.y, 0, 0.30);
        head.position.z = lp(head.position.z, 0, 0.30);
      }
      if (behavior === 'angry') {
        head.rotation.z += Math.sin(now * 19.0) * 0.022;
      }
    }

    // Tick the VRM internals (spring bones, lookAt, etc.)
    vrm.update(delta);
  }

  return { tick, jitterObj };
}
