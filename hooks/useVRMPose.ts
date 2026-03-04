import { useRef } from 'react';
import * as THREE from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { TrackingData } from './useMediaPipeTracking';
import type { EmotionMode, BehaviorMode } from './useVRMFace';

const lp = THREE.MathUtils.lerp;
const R_DOWN = -1.25;
const L_DOWN = 1.25;

export interface UseVRMPoseArgs {
  vrmRef: React.RefObject<VRM | null>;
  trackingRef?: React.RefObject<TrackingData>;
  emotionMode: EmotionMode;
  behaviorMode: BehaviorMode;
  isNodding: boolean;
  isShaking: boolean;
  onNodEnd: () => void;
  onShakeEnd: () => void;
}

export function useVRMPose({
  vrmRef,
  trackingRef,
  emotionMode,
  behaviorMode,
  isNodding,
  isShaking,
  onNodEnd,
  onShakeEnd
}: UseVRMPoseArgs) {
  const swP = useRef(Math.random() * Math.PI * 2);
  const jitP = useRef(0);
  const nodT = useRef(0);
  const shakeT = useRef(0);

  const nodDone = useRef(false);
  const shakeDone = useRef(false);
  const prevNod = useRef(false);
  const prevShake = useRef(false);
  const gigglingT = useRef(-1);
  const prevGiggle = useRef(false);
  const boredLookYaw = useRef(0);
  const boredLookTimer = useRef(0);
  const boredSwayPh = useRef(0);
  const jitterObj = useRef(new THREE.Object3D());
  const saccadeTimer = useRef(0);
  const saccadeTarget = useRef(new THREE.Vector2(0, 0));
  const waveTimer = useRef(0);
  const foldedHandsTimer = useRef(0);
  const spineLean = useRef(0);
  const yawnTimer = useRef(0);
  const knockTimer = useRef(0);
  const knockCount = useRef(0);
  const waveAnimPhase = useRef(0);
  const randomLookTimer = useRef(0);
  const randomLookTarget = useRef(new THREE.Vector2(0, 0));

  const tick = (
    delta: number,
    now: number,
    isSpeaking: boolean,
    headReact: boolean,
    curAa: number
  ) => {
    const vrm = vrmRef.current;
    if (!vrm) return;
    const h = vrm.humanoid;
    if (!h) return;
    const T = trackingRef?.current;
    const tracked = T?.active || false;

    swP.current += delta * 0.28;
    boredSwayPh.current += delta * 0.12;

    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);
    const rUA = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rSh = h.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = h.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rHd = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);
    const lHd = h.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);

    // Keep wrist yaw neutral by default; specific gestures (wave) can override it.
    if (rHd) rHd.rotation.y = lp(rHd.rotation.y, 0, 0.10);
    if (lHd) lHd.rotation.y = lp(lHd.rotation.y, 0, 0.10);

    // LAYER 1: ORGANIC BREATHING & LEANING
    const breathRate = isSpeaking ? 0.35 : (emotionMode === 'angry' ? 0.45 : 0.25);
    const BREATH = breathRate * Math.PI * 2;
    const breathPhase = now * BREATH + Math.sin(now * 0.5) * 0.5;
    const inhale = Math.sin(breathPhase);
    const exhale = Math.cos(breathPhase);
    const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);

    // Lean forward slightly when speaking and tracked
    const targetLean = isSpeaking ? 0.08 : 0.0;
    spineLean.current = lp(spineLean.current, targetLean, 0.03);

    if (spine) {
      spine.rotation.x = lp(spine.rotation.x, spineLean.current - inhale * 0.005 * 0.40, 0.05);
      spine.rotation.z = lp(spine.rotation.z, exhale * 0.005 * 0.15, 0.04);
    }
    if (chest) {
      chest.rotation.x = lp(chest.rotation.x, spineLean.current * 0.5 - inhale * 0.005 * 0.60, 0.05);
    }

    // MICRO-SACCADES (Eye darts)
    saccadeTimer.current -= delta;
    if (saccadeTimer.current <= 0) {
      saccadeTarget.current.set((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1);
      saccadeTimer.current = 0.5 + Math.random() * 2.5;
      if (isSpeaking) saccadeTimer.current *= 0.6;
    }

    if (neck && head) {
      if (isNodding && !prevNod.current) { nodT.current = 0; nodDone.current = false; }
      if (isShaking && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current = isNodding; prevShake.current = isShaking;

      if (tracked && T!.isGiggling && !prevGiggle.current) gigglingT.current = 0;
      if (!T?.isGiggling) gigglingT.current = -1;
      prevGiggle.current = tracked && T!.isGiggling;
      if (gigglingT.current >= 0) gigglingT.current += delta;

      // Reliable wave trigger: explicit gesture, raised hand, or visible hand while idle.
      if (
        tracked && T && (
          (T.handDetected && T.handRaised) ||
          T.gesture === 'Open_Palm' ||
          T.gesture === 'Victory' ||
          T.gesture === 'Thumb_Up'
        )
      ) {
        waveTimer.current = Math.max(waveTimer.current, 1.2);
      }

      if (!isSpeaking && !headReact && waveTimer.current <= 0 && behaviorMode === 'neutral') {
        if (Math.random() < 0.003) foldedHandsTimer.current = 2.0 + Math.random() * 4.0;
      }
      if (isSpeaking || headReact || waveTimer.current > 0) foldedHandsTimer.current = 0;
      if (foldedHandsTimer.current > 0) foldedHandsTimer.current -= delta;

      if (isNodding) {
        nodT.current += delta;
        if (nodT.current < 2.0) { head.rotation.x = Math.sin(nodT.current * Math.PI * 2.5) * 0.18; head.rotation.y = lp(head.rotation.y, 0, 0.08); head.rotation.z = lp(head.rotation.z, 0, 0.08); neck.rotation.x = lp(neck.rotation.x, 0, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); }
        else { head.rotation.x = lp(head.rotation.x, 0, 0.10); if (!nodDone.current) { nodDone.current = true; onNodEnd(); } }
      } else if (isShaking) {
        shakeT.current += delta;
        if (shakeT.current < 2.0) { head.rotation.y = Math.sin(shakeT.current * Math.PI * 3.5) * 0.18; head.rotation.x = lp(head.rotation.x, 0, 0.08); head.rotation.z = lp(head.rotation.z, 0, 0.08); neck.rotation.x = lp(neck.rotation.x, 0, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); }
        else { head.rotation.y = lp(head.rotation.y, 0, 0.10); if (!shakeDone.current) { shakeDone.current = true; onShakeEnd(); } }
      } else if (tracked && T && gigglingT.current >= 0) {
        const gig = gigglingT.current; const bounce = Math.sin(gig * Math.PI * 8.0) * 0.06;
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.5, 0.10); neck.rotation.y = lp(neck.rotation.y, T.headYaw * 0.4, 0.10); neck.rotation.z = lp(neck.rotation.z, T.headRoll * 0.4, 0.10);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.5 + bounce, 0.15); head.rotation.y = lp(head.rotation.y, T.headYaw * 0.6, 0.12); head.rotation.z = lp(head.rotation.z, T.headRoll * 0.6 + 0.15 + Math.sin(gig * 5.0) * 0.04, 0.12);
      } else if (yawnTimer.current > 0) {
        // Look up slightly when yawning
        neck.rotation.x = lp(neck.rotation.x, -0.2, 0.05);
        head.rotation.x = lp(head.rotation.x, -0.3, 0.05);
      } else if (knockTimer.current > 0) {
        // Lean in as if looking through the screen while knocking
        neck.rotation.x = lp(neck.rotation.x, 0.3, 0.1);
        head.rotation.x = lp(head.rotation.x, -0.1, 0.1);
        head.rotation.y = lp(head.rotation.y, 0, 0.1);
      } else if (behaviorMode === 'loudLaugh') {
        jitP.current += delta * 1.5;
        neck.rotation.x = lp(neck.rotation.x, -0.32, 0.10); neck.rotation.z = lp(neck.rotation.z, 0.0, 0.08);
        head.rotation.x = lp(head.rotation.x, -0.40, 0.10); head.rotation.y = lp(head.rotation.y, Math.sin(jitP.current * 0.8) * 0.12, 0.06); head.rotation.z = lp(head.rotation.z, Math.sin(jitP.current * 1.1) * 0.06, 0.06);
      } else if (behaviorMode === 'shyGiggle') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.22, 0.08); neck.rotation.z = lp(neck.rotation.z, 0.12, 0.06);
        head.rotation.x = lp(head.rotation.x, 0.18 + Math.sin(now * 6.0) * 0.012, 0.08); head.rotation.y = lp(head.rotation.y, 0.15, 0.06); head.rotation.z = lp(head.rotation.z, 0.10, 0.06);
      } else if (behaviorMode === 'guilty') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.55, 0.05); neck.rotation.z = lp(neck.rotation.z, 0.04, 0.04);
        head.rotation.x = lp(head.rotation.x, 0.60, 0.05); head.rotation.y = lp(head.rotation.y, 0, 0.04); head.rotation.z = lp(head.rotation.z, 0, 0.04);
      } else if (behaviorMode === 'angry') {
        jitP.current += delta * 28;
        neck.rotation.x = lp(neck.rotation.x, 0.15, 0.12); neck.rotation.z = lp(neck.rotation.z, 0, 0.10);
        head.rotation.x = lp(head.rotation.x, 0.10, 0.12); head.rotation.y = lp(head.rotation.y, 0, 0.10);
      } else if (behaviorMode === 'blush') {
        jitP.current = 0;
        neck.rotation.x = lp(neck.rotation.x, 0.10, 0.05); neck.rotation.z = lp(neck.rotation.z, 0.08, 0.05);
        head.rotation.x = lp(head.rotation.x, 0.08, 0.05); head.rotation.y = lp(head.rotation.y, 0, 0.04); head.rotation.z = lp(head.rotation.z, 0.06, 0.04);
      } else if (tracked && T) {
        let pitchOffset = 0; let rollOffset = 0;
        if (emotionMode === 'angry') pitchOffset = 0.08; if (emotionMode === 'sad') pitchOffset = 0.18;
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.12); neck.rotation.y = lp(neck.rotation.y, T.headYaw * 0.45, 0.12); neck.rotation.z = lp(neck.rotation.z, T.headRoll * 0.40 + rollOffset, 0.12);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.50 + pitchOffset, 0.14); head.rotation.y = lp(head.rotation.y, T.headYaw * 0.55, 0.14); head.rotation.z = lp(head.rotation.z, T.headRoll * 0.60, 0.14);
        if (T.isBored) {
          if (now > boredLookTimer.current) { boredLookYaw.current = (Math.random() - 0.5) * 0.55; boredLookTimer.current = now + 5.0 + Math.random() * 5.0; }
          const bsway = Math.sin(boredSwayPh.current) * 0.025;
          head.rotation.y = lp(head.rotation.y, boredLookYaw.current + bsway, 0.015); head.rotation.z = lp(head.rotation.z, boredLookYaw.current * 0.15 + bsway * 0.4, 0.012);
        }
      } else if (headReact && emotionMode === 'angry') {
        jitP.current += delta * 32;
        neck.rotation.x = lp(neck.rotation.x, 0.18, 0.14); neck.rotation.z = lp(neck.rotation.z, -0.08, 0.12);
        head.rotation.x = lp(head.rotation.x, 0.14, 0.14); head.rotation.z = Math.sin(jitP.current) * 0.045;
      } else if (emotionMode === 'angry' && isSpeaking) {
        jitP.current = 0; neck.rotation.x = lp(neck.rotation.x, 0.10, 0.08); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); head.rotation.x = lp(head.rotation.x, 0.08, 0.08); head.rotation.z = lp(head.rotation.z, 0, 0.06); head.rotation.y = lp(head.rotation.y, 0, 0.06);
      } else if (emotionMode === 'sad') {
        jitP.current = 0; neck.rotation.x = lp(neck.rotation.x, 0.20, 0.04); neck.rotation.z = lp(neck.rotation.z, 0.06, 0.03); head.rotation.x = lp(head.rotation.x, 0.10, 0.04); head.rotation.y = lp(head.rotation.y, 0, 0.04); head.rotation.z = lp(head.rotation.z, 0.04, 0.03);
      } else if (emotionMode === 'happy') {
        jitP.current = 0; const sway = Math.sin(swP.current * 1.4) * 0.030; neck.rotation.z = lp(neck.rotation.z, sway, 0.04); neck.rotation.x = lp(neck.rotation.x, -0.02, 0.04); head.rotation.z = lp(head.rotation.z, sway * 1.2, 0.05); head.rotation.x = lp(head.rotation.x, -0.02, 0.04); head.rotation.y = lp(head.rotation.y, Math.sin(swP.current * 0.8) * 0.020, 0.04);
      } else if (isSpeaking) {
        jitP.current = 0; const spk = Math.sin(now * 3.5) * curAa * 0.04; neck.rotation.x = lp(neck.rotation.x, -curAa * 0.04, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); head.rotation.x = lp(head.rotation.x, -curAa * 0.06 + spk, 0.08); head.rotation.y = lp(head.rotation.y, 0, 0.06); head.rotation.z = lp(head.rotation.z, 0, 0.06);
      } else {
        jitP.current = 0; const s = swP.current; const amp = 0.012; const brth = Math.sin(now * 1.57) * 0.004;

        // Random looking around
        randomLookTimer.current -= delta;
        if (randomLookTimer.current <= 0) {
          randomLookTarget.current.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4);
          randomLookTimer.current = 3.0 + Math.random() * 5.0; // Change look target every 3-8s
        }

        // Disabled random gesture triggers; wave should be hand-driven for predictability.

        const lTargX = randomLookTarget.current.x;
        const lTargY = randomLookTarget.current.y;

        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp + brth + lTargY * 0.3, 0.04);
        neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5, 0.025);
        neck.rotation.y = lp(neck.rotation.y, lTargX * 0.4, 0.05);

        head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2 - brth * 0.5 + lTargY * 0.7, 0.05);
        head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7 + lTargX * 0.6, 0.05);
        head.rotation.z = lp(head.rotation.z, Math.sin(s) * amp * 0.35, 0.030);
      }
    }

    // Calculate timers
    if (waveTimer.current > 0) waveTimer.current -= delta;
    else waveAnimPhase.current = 0;
    if (yawnTimer.current > 0) yawnTimer.current -= delta;
    if (knockTimer.current > 0) knockTimer.current -= delta;

    if (waveTimer.current > 0) {
      waveAnimPhase.current += delta;
      if (head) { head.rotation.z = lp(head.rotation.z, 0.14, 0.12); } // stronger right tilt
      const wPhase = waveAnimPhase.current * Math.PI * 5; // smooth incrementing wave phase

      // Keep waving arm beside face and biased to avatar's right side.
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0.03, 0.15); rSh.rotation.x = lp(rSh.rotation.x, -0.10, 0.15); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.1); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.1); }

      // Upper arm lifted near cheek level using normalized down constants.
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.55, 0.26); rUA.rotation.y = lp(rUA.rotation.y, 0.34, 0.22); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN + 0.26, 0.2); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.1); lUA.rotation.y = lp(lUA.rotation.y, 0, 0.1); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.1); }

      // Forearm/hand do the actual waving with a tighter arc so they stay in-frame.
      if (rLA) {
        rLA.rotation.x = lp(rLA.rotation.x, -1.05, 0.22);
        rLA.rotation.y = lp(rLA.rotation.y, 0.22, 0.24);
        rLA.rotation.z = lp(rLA.rotation.z, Math.sin(wPhase) * 0.08 + 0.01, 0.25);
      }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.1); lLA.rotation.y = lp(lLA.rotation.y, 0, 0.1); lLA.rotation.z = lp(lLA.rotation.z, 0, 0.1); }

      if (rHd) {
        // Stronger palm-facing orientation during wave.
        rHd.rotation.x = lp(rHd.rotation.x, 0.42, 0.24);
        rHd.rotation.y = lp(rHd.rotation.y, 1.12, 0.24);
        rHd.rotation.z = lp(rHd.rotation.z, Math.sin(wPhase + 1.5) * 0.08, 0.25);
      }
      if (lHd) {
        lHd.rotation.x = lp(lHd.rotation.x, 0, 0.1);
        lHd.rotation.y = lp(lHd.rotation.y, 0, 0.1);
        lHd.rotation.z = lp(lHd.rotation.z, 0, 0.1);
      }
    } else if (yawnTimer.current > 0) {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.1, 0.1); rSh.rotation.x = lp(rSh.rotation.x, 0.2, 0.1); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0.1, 0.1); lSh.rotation.x = lp(lSh.rotation.x, 0.2, 0.1); }
      // Bring hands to mouth to yawn
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.0, 0.08); rUA.rotation.z = lp(rUA.rotation.z, -0.4, 0.08); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -1.0, 0.08); lUA.rotation.z = lp(lUA.rotation.z, 0.4, 0.08); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.8, 0.1); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -1.8, 0.1); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0.5, 0.1); }
      if (lHd) { lHd.rotation.x = lp(lHd.rotation.x, 0.5, 0.1); }
    } else if (knockTimer.current > 0) {
      // Screen knocking!
      // Make them raise right hand to knock on the camera glass
      const knockFreq = Math.sin(knockTimer.current * Math.PI * 10);

      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0.2, 0.1); rSh.rotation.x = lp(rSh.rotation.x, -0.1, 0.1); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.1); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.1); }

      // Arm up, hand slightly in front of face
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.0, 0.2); rUA.rotation.z = lp(rUA.rotation.z, -0.5, 0.2); }
      if (lUA) { lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.2); }

      // Repeatedly knock forward against invisible glass (Z axis)
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.5, 0.2); rLA.rotation.z = lp(rLA.rotation.z, knockFreq > 0.5 ? 0.3 : -0.1, 0.3); }

      // Fist shape for hand? We can't strictly modify finger bones easily without adding them, but we tilt hand down.
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.5, 0.3); }
    } else if ((tracked && T && (T.handToMouth || T.isGiggling)) || behaviorMode === 'shyGiggle') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.10, 0.10); rSh.rotation.x = lp(rSh.rotation.x, 0.05, 0.10); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.50, 0.14); rUA.rotation.z = lp(rUA.rotation.z, -0.55, 0.14); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.00, 0.12); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.20, 0.10); rHd.rotation.z = lp(rHd.rotation.z, 0.15, 0.10); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 1.25, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
    } else if (behaviorMode === 'guilty') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.12, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.15, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0.12, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.15, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.25, 0.05); rUA.rotation.z = lp(rUA.rotation.z, -1.50, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.20, 0.05); lUA.rotation.z = lp(lUA.rotation.z, 1.50, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0.10, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0.10, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    } else if (behaviorMode === 'loudLaugh') {
      const b1 = Math.sin(now * 4.5) * 0.10;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.25, 0.07); rUA.rotation.z = lp(rUA.rotation.z, -1.60 + b1, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.20, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 1.55 - b1, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.06); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.06); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.06); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.06); }
    } else if (emotionMode === 'sad') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.18, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.12, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0.18, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.12, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.10, 0.04); rUA.rotation.z = lp(rUA.rotation.z, -1.33, 0.04); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.10, 0.04); lUA.rotation.z = lp(lUA.rotation.z, 1.33, 0.04); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    } else if (isSpeaking) {
      const intensity = emotionMode === 'angry' ? 1.4 : emotionMode === 'happy' ? 1.2 : 1.0;
      // Make it more expressive for children: wider, more frequent hand movements
      const b1 = Math.sin(now * 3.8) * 0.35 * intensity;
      const b2 = Math.sin(now * 3.8 + Math.PI * .5) * 0.35 * intensity;
      const wave1 = Math.sin(now * 1.5) * 0.2;
      const wave2 = Math.cos(now * 1.8) * 0.2;

      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0.05, 0.06); rSh.rotation.x = lp(rSh.rotation.x, -0.05, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, -0.05, 0.06); lSh.rotation.x = lp(lSh.rotation.x, -0.05, 0.06); }

      // Speaking motion: keep both arms near neutral and avoid overhead poses.
      if (rUA) {
        rUA.rotation.x = lp(rUA.rotation.x, -0.08 + wave1 * 0.14, 0.10);
        rUA.rotation.y = lp(rUA.rotation.y, 0.08, 0.10);
        rUA.rotation.z = lp(rUA.rotation.z, R_DOWN + 0.05 + b1 * 0.03, 0.10);
      }
      // Mild elbow movement while speaking.
      if (rLA) {
        rLA.rotation.x = lp(rLA.rotation.x, -0.28 + b1 * 0.12, 0.13);
        rLA.rotation.z = lp(rLA.rotation.z, 0.05 + wave1 * 0.12, 0.13);
      }
      if (lUA) {
        lUA.rotation.x = lp(lUA.rotation.x, -0.08 + wave2 * 0.14, 0.09);
        lUA.rotation.y = lp(lUA.rotation.y, -0.08, 0.09);
        lUA.rotation.z = lp(lUA.rotation.z, L_DOWN - 0.05 - b2 * 0.03, 0.09);
      }
      if (lLA) {
        lLA.rotation.x = lp(lLA.rotation.x, -0.28 + b2 * 0.12, 0.11);
        lLA.rotation.z = lp(lLA.rotation.z, -0.05 + wave2 * 0.12, 0.11);
      }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.2, 0.08); rHd.rotation.z = lp(rHd.rotation.z, b1 * 0.4, 0.08); }
      if (lHd) { lHd.rotation.x = lp(lHd.rotation.x, -0.2, 0.08); lHd.rotation.z = lp(lHd.rotation.z, b2 * 0.4, 0.08); }
    } else if (foldedHandsTimer.current > 0) {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0.1, 0.05); rSh.rotation.x = lp(rSh.rotation.x, -0.1, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, -0.1, 0.05); lSh.rotation.x = lp(lSh.rotation.x, -0.1, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.3, 0.05); rUA.rotation.y = lp(rUA.rotation.y, 0.4, 0.05); rUA.rotation.z = lp(rUA.rotation.z, 0.3, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.3, 0.05); lUA.rotation.y = lp(lUA.rotation.y, -0.4, 0.05); lUA.rotation.z = lp(lUA.rotation.z, -0.3, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.2, 0.08); rLA.rotation.z = lp(rLA.rotation.z, 0.6, 0.08); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -1.2, 0.08); lLA.rotation.z = lp(lLA.rotation.z, -0.6, 0.08); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.1, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    } else {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.05); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.05); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.05); rUA.rotation.y = lp(rUA.rotation.y, 0, 0.05); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.05); rLA.rotation.z = lp(rLA.rotation.z, 0, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.05); lUA.rotation.y = lp(lUA.rotation.y, 0, 0.05); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.05); lLA.rotation.z = lp(lLA.rotation.z, 0, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    }

    if (head) {
      if (behaviorMode === 'loudLaugh') {
        const vA = 0.004;
        head.position.x = Math.sin(now * 22.0) * vA;
        head.position.y = Math.sin(now * 30.1) * vA * 0.60;
        head.position.z = Math.sin(now * 17.3) * vA * 0.50;
      } else if (knockTimer.current > 0) {
        // Bring face much closer to the camera when knocking!
        head.position.z = lp(head.position.z, 0.35, 0.1);
        head.position.y = lp(head.position.y, -0.05, 0.1);
      } else {
        head.position.x = lp(head.position.x, 0, 0.30);
        head.position.y = lp(head.position.y, 0, 0.30);
        head.position.z = lp(head.position.z, 0, 0.30);
      }
      if (behaviorMode === 'angry') {
        head.rotation.z += Math.sin(now * 19.0) * 0.022;
      }
    }

    // Apply micro-saccades to eyes if available
    const leftEye = h.getNormalizedBoneNode(VRMHumanBoneName.LeftEye);
    const rightEye = h.getNormalizedBoneNode(VRMHumanBoneName.RightEye);
    if (leftEye && rightEye) {
      // Offset the X rotation heavily so the avatar looks 'up' slightly by default
      const UP_ANGLE = -0.12;
      leftEye.rotation.y = lp(leftEye.rotation.y, saccadeTarget.current.x, 0.3);
      leftEye.rotation.x = lp(leftEye.rotation.x, saccadeTarget.current.y + UP_ANGLE, 0.3);
      rightEye.rotation.y = lp(rightEye.rotation.y, saccadeTarget.current.x, 0.3);
      rightEye.rotation.x = lp(rightEye.rotation.x, saccadeTarget.current.y + UP_ANGLE, 0.3);
    } else if (head) {
      head.rotation.y += saccadeTarget.current.x * 0.2;
      head.rotation.x += saccadeTarget.current.y * 0.2;
    }
  };

  return { tick, jitterObj };
}
