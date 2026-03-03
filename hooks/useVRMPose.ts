import { useRef } from 'react';
import * as THREE from 'three';
import { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { TrackingData } from './useMediaPipeTracking';

const lp = THREE.MathUtils.lerp;
const R_DOWN = -1.35;
const L_DOWN = 1.35;

export function useVRMPose() {
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

  const tickPose = (
    vrm: VRM | null, trackingRef: React.RefObject<TrackingData>, behaviorMode: string, emotionMode: string,
    isSpeaking: boolean, headReact: boolean, curAa: number,
    isNodding: boolean, isShaking: boolean, onNodEnd: () => void, onShakeEnd: () => void,
    now: number, delta: number
  ) => {
    if (!vrm) return;
    const h = vrm.humanoid;
    const T = trackingRef.current;
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

    // LAYER 1: BREATHING
    const BREATH = 0.25 * Math.PI * 2;
    const inhale = Math.sin(now * BREATH);
    const exhale = Math.cos(now * BREATH);
    const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
    
    if (spine) {
      spine.rotation.x = lp(spine.rotation.x, -inhale * 0.005 * 0.40, 0.05);
      spine.rotation.z = lp(spine.rotation.z, exhale * 0.005 * 0.15, 0.04);
    }
    if (chest) {
      chest.rotation.x = lp(chest.rotation.x, -inhale * 0.005 * 0.60, 0.05);
    }

    if (neck && head) {
      if (isNodding && !prevNod.current) { nodT.current = 0; nodDone.current = false; }
      if (isShaking && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current = isNodding; prevShake.current = isShaking;

      if (tracked && T!.isGiggling && !prevGiggle.current) gigglingT.current = 0;
      if (!T?.isGiggling) gigglingT.current = -1;
      prevGiggle.current = tracked && T!.isGiggling;
      if (gigglingT.current >= 0) gigglingT.current += delta;

      if (isNodding) {
        nodT.current += delta;
        if (nodT.current < 2.0) { head.rotation.x = Math.sin(nodT.current * Math.PI * 2.5) * 0.18; head.rotation.y = lp(head.rotation.y, 0, 0.08); head.rotation.z = lp(head.rotation.z, 0, 0.08); neck.rotation.x = lp(neck.rotation.x, 0, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); } 
        else { head.rotation.x = lp(head.rotation.x, 0, 0.10); if (!nodDone.current) { nodDone.current = true; onNodEnd(); } }
      } else if (isShaking) {
        shakeT.current += delta;
        if (shakeT.current < 2.0) { head.rotation.y = Math.sin(shakeT.current * Math.PI * 3.5) * 0.18; head.rotation.x = lp(head.rotation.x, 0, 0.08); head.rotation.z = lp(head.rotation.z, 0, 0.08); neck.rotation.x = lp(neck.rotation.x, 0, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); } 
        else { head.rotation.y = lp(head.rotation.y, 0, 0.10); if (!shakeDone.current) { shakeDone.current = true; onShakeEnd(); } }
      } else if (tracked && gigglingT.current >= 0) {
        const gig = gigglingT.current; const bounce = Math.sin(gig * Math.PI * 8.0) * 0.06;    
        neck.rotation.x = lp(neck.rotation.x, T!.headPitch * 0.5, 0.10); neck.rotation.y = lp(neck.rotation.y, T!.headYaw * 0.4, 0.10); neck.rotation.z = lp(neck.rotation.z, T!.headRoll * 0.4, 0.10);
        head.rotation.x = lp(head.rotation.x, T!.headPitch * 0.5 + bounce, 0.15); head.rotation.y = lp(head.rotation.y, T!.headYaw * 0.6, 0.12); head.rotation.z = lp(head.rotation.z, T!.headRoll * 0.6 + 0.15 + Math.sin(gig * 5.0) * 0.04, 0.12);
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
      } else if (tracked) {
        let pitchOffset = 0; let rollOffset = 0;
        if (emotionMode === 'angry') pitchOffset = 0.08; if (emotionMode === 'sad') pitchOffset = 0.18;
        neck.rotation.x = lp(neck.rotation.x, T!.headPitch * 0.50 + pitchOffset, 0.12); neck.rotation.y = lp(neck.rotation.y, T!.headYaw * 0.45, 0.12); neck.rotation.z = lp(neck.rotation.z, T!.headRoll * 0.40 + rollOffset, 0.12);
        head.rotation.x = lp(head.rotation.x, T!.headPitch * 0.50 + pitchOffset, 0.14); head.rotation.y = lp(head.rotation.y, T!.headYaw * 0.55, 0.14); head.rotation.z = lp(head.rotation.z, T!.headRoll * 0.60, 0.14);
        if (T!.isBored) {
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
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp + brth, 0.025); neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5, 0.025); head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2 - brth * 0.5, 0.030); head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7, 0.030); head.rotation.z = lp(head.rotation.z, Math.sin(s) * amp * 0.35, 0.030);
      }
    }

    if ((tracked && (T!.handToMouth || T!.isGiggling)) || behaviorMode === 'shyGiggle') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.10, 0.10); rSh.rotation.x = lp(rSh.rotation.x,  0.05, 0.10); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -1.50, 0.14); rUA.rotation.z = lp(rUA.rotation.z, -0.55, 0.14); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -1.00, 0.12); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, -0.20, 0.10); rHd.rotation.z = lp(rHd.rotation.z,  0.15, 0.10); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 1.25, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
    } else if (behaviorMode === 'guilty') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.12, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.15, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.12, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.15, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.25, 0.05); rUA.rotation.z = lp(rUA.rotation.z, -1.50, 0.05); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.20, 0.05); lUA.rotation.z = lp(lUA.rotation.z,  1.50, 0.05); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0.10, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0.10, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    } else if (behaviorMode === 'loudLaugh') {
      const b1 = Math.sin(now * 4.5) * 0.10;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.25, 0.07); rUA.rotation.z = lp(rUA.rotation.z, -1.60 + b1, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.20, 0.07); lUA.rotation.z = lp(lUA.rotation.z,  1.55 - b1, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.06); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.06); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.06); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.06); }
    } else if (emotionMode === 'sad') {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, -0.18, 0.04); rSh.rotation.x = lp(rSh.rotation.x, 0.12, 0.04); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z,  0.18, 0.04); lSh.rotation.x = lp(lSh.rotation.x, 0.12, 0.04); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0.10, 0.04); rUA.rotation.z = lp(rUA.rotation.z, -1.33, 0.04); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0.10, 0.04); lUA.rotation.z = lp(lUA.rotation.z,  1.33, 0.04); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.05); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.05); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.05); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.05); }
    } else if (isSpeaking) {
      const intensity = emotionMode === 'angry' ? 1.4 : emotionMode === 'happy' ? 1.2 : 1.0;
      const b1 = Math.sin(now * 3.2)               * 0.14 * intensity;
      const b2 = Math.sin(now * 3.2 + Math.PI * .5) * 0.11 * intensity;
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.06); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.06); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.06); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.06); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.45 * intensity, 0.10); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN - 0.22 * intensity, 0.10); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1, 0.13); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.28 * intensity, 0.09); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN + 0.16 * intensity, 0.09); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2, 0.11); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.08); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.08); }
    } else {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.05); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.05); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.07); rUA.rotation.z = lp(rUA.rotation.z, R_DOWN, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, L_DOWN, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.07); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.07); }
    }

    if (head) {
      if (behaviorMode === 'loudLaugh') {
        const vA = 0.004;
        head.position.x = Math.sin(now * 22.0)             * vA;
        head.position.y = Math.sin(now * 30.1)             * vA * 0.60;
        head.position.z = Math.sin(now * 17.3)             * vA * 0.50;
      } else {
        head.position.x = lp(head.position.x, 0, 0.30);
        head.position.y = lp(head.position.y, 0, 0.30);
        head.position.z = lp(head.position.z, 0, 0.30);
      }
      if (behaviorMode === 'angry') {
        head.rotation.z += Math.sin(now * 19.0) * 0.022;
      }
    }
  };

  return { tickPose };
}