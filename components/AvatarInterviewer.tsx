/**
 * AvatarInterviewer.tsx — v6
 * Audio       → useVRMVoice
 * Expressions → useVRMFace
 */
import { useRef, useState, useCallback, useEffect, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { useMediaPipeTracking, type TrackingData } from '../hooks/useMediaPipeTracking';
import { useVRMFace } from '../hooks/useVRMFace';
import { useVRMVoice } from '../hooks/useVRMVoice';

// Re-export so external consumers keep the same import paths
export type { EmotionMode, BehaviorMode } from '../hooks/useVRMFace';
import type { EmotionMode, BehaviorMode } from '../hooks/useVRMFace';
import type { AudioMode } from '../hooks/useVRMVoice';

const AVATAR_URL = '/Anurag.vrm';
const lp = THREE.MathUtils.lerp;

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

function VRMAvatarMesh({ analyserRef, trackingRef, emotionMode, behaviorMode, isNodding, isShaking, onNodEnd, onShakeEnd }: MeshProps) {
  const { camera } = useThree();
  const groupRef   = useRef<THREE.Group>(null!);
  const vrmRef     = useRef<VRM | null>(null);

  // Face expressions delegated to useVRMFace
  const face = useVRMFace({ vrmRef, analyserRef, trackingRef, emotionMode, behaviorMode });

  const swP = useRef(Math.random() * Math.PI * 2);

  const nodT      = useRef(0);
  const shakeT    = useRef(0);
  const nodDone   = useRef(false);
  const shakeDone = useRef(false);
  const prevNod   = useRef(false);
  const prevShake = useRef(false);

  const jitP = useRef(0);

  const jitterObj   = useRef(new THREE.Object3D());
  const jitterGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const jitterNextT = useRef(0);

  const nystagmusGoal  = useRef(new THREE.Vector3(0, 0, 2));
  const nystagmusTimer = useRef(0);
  const headVibDecay   = useRef(new THREE.Vector3());

  const gigglingT   = useRef(-1); 
  const prevGiggle  = useRef(false);

  const boredLookYaw   = useRef(0);  
  const boredLookTimer = useRef(0);   
  const boredSwayPh    = useRef(0);   

  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));
    loader.load(
      AVATAR_URL,
      gltf => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) return;
        vrm.lookAt.target = jitterObj.current;
        groupRef.current.add(vrm.scene);
        vrmRef.current = vrm;
      },
      undefined,
      err => console.error('[VRM] load error', err)
    );
    return () => { if (vrmRef.current) { groupRef.current?.remove(vrmRef.current.scene); vrmRef.current = null; } };
  }, []);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const now     = state.clock.elapsedTime;
    const T       = trackingRef.current;
    const tracked = T.active;
    const h       = vrm.humanoid;

    swP.current         += delta * 0.28;
    boredSwayPh.current += delta * 0.12;

    {
      const BREATH  = 0.25 * Math.PI * 2;  
      const inhale  = Math.sin(now * BREATH);
      const exhale  = Math.cos(now * BREATH);
      const BAMP    = 0.005;               

      const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
      const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
      
      if (spine) { spine.rotation.x = lp(spine.rotation.x, -inhale * BAMP * 0.40, 0.05); spine.rotation.z = lp(spine.rotation.z,  exhale * BAMP * 0.15, 0.04); }
      if (chest) { chest.rotation.x = lp(chest.rotation.x, -inhale * BAMP * 0.60, 0.05); }
    }

    {
      const cp = new THREE.Vector3();
      camera.getWorldPosition(cp);
      const isNystagmus = !tracked && (behaviorMode === 'neutral' || emotionMode === 'sad');
      const isLazy = behaviorMode === 'shyGiggle' || behaviorMode === 'blush';

      if (isNystagmus) {
        if (now >= nystagmusTimer.current) { nystagmusGoal.current.set(cp.x + (Math.random() - 0.5) * 0.070, cp.y + (Math.random() - 0.5) * 0.050, cp.z); nystagmusTimer.current = now + 0.15 + Math.random() * 0.30; }
        jitterObj.current.position.lerp(nystagmusGoal.current, delta * 22.0);
      } else {
        if (now >= jitterNextT.current) { jitterGoal.current.set(cp.x + (Math.random() - 0.5) * 0.06, cp.y + (Math.random() - 0.5) * 0.04, cp.z); jitterNextT.current = now + 2.0 + Math.random() * 2.0; }
        const lookAlpha = isLazy ? delta * 1.8 : behaviorMode === 'angry' ? delta * 9.0 : behaviorMode === 'loudLaugh' ? delta * 3.5 : delta * 6.0;
        jitterObj.current.position.lerp(jitterGoal.current, lookAlpha);
      }
    }

    // LAYER 2 – face expressions (lip-sync + blendshapes + blinks)
    const { isSpeaking, headReact } = face.tick(now);

    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);

    if (neck && head) {
      if (isNodding && !prevNod.current) { nodT.current = 0; nodDone.current = false; }
      if (isShaking && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current = isNodding; prevShake.current = isShaking;

      if (tracked && T.isGiggling && !prevGiggle.current) gigglingT.current = 0;
      if (!T.isGiggling) gigglingT.current = -1;
      prevGiggle.current = tracked && T.isGiggling;
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
        neck.rotation.x = lp(neck.rotation.x, T.headPitch * 0.5, 0.10); neck.rotation.y = lp(neck.rotation.y, T.headYaw * 0.4, 0.10); neck.rotation.z = lp(neck.rotation.z, T.headRoll * 0.4, 0.10);
        head.rotation.x = lp(head.rotation.x, T.headPitch * 0.5 + bounce, 0.15); head.rotation.y = lp(head.rotation.y, T.headYaw * 0.6, 0.12); head.rotation.z = lp(head.rotation.z, T.headRoll * 0.6 + 0.15 + Math.sin(gig * 5.0) * 0.04, 0.12);
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
        jitP.current = 0; const jaw = face.curExpr.current.aa; const spk = Math.sin(now * 3.5) * jaw * 0.04; neck.rotation.x = lp(neck.rotation.x, -jaw * 0.04, 0.06); neck.rotation.z = lp(neck.rotation.z, 0, 0.06); head.rotation.x = lp(head.rotation.x, -jaw * 0.06 + spk, 0.08); head.rotation.y = lp(head.rotation.y, 0, 0.06); head.rotation.z = lp(head.rotation.z, 0, 0.06);
      } else {
        jitP.current = 0; const s = swP.current; const amp = 0.012; const brth = Math.sin(now * 1.57) * 0.004;   
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * amp + brth, 0.025); neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * amp * 0.5, 0.025); head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * amp * 1.2 - brth * 0.5, 0.030); head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * amp * 0.7, 0.030); head.rotation.z = lp(head.rotation.z, Math.sin(s) * amp * 0.35, 0.030);
      }
    }

    const rUA = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rSh = h.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = h.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rHd = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

    if ((tracked && (T.handToMouth || T.isGiggling)) || behaviorMode === 'shyGiggle') {
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
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, -0.45 * intensity, 0.10); rUA.rotation.z = lp(rUA.rotation.z, -1.47 * intensity, 0.10); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1, 0.13); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, -0.28 * intensity, 0.09); lUA.rotation.z = lp(lUA.rotation.z, 1.41 * intensity, 0.09); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2, 0.11); }
      if (rHd) { rHd.rotation.x = lp(rHd.rotation.x, 0, 0.08); rHd.rotation.z = lp(rHd.rotation.z, 0, 0.08); }
    } else {
      if (rSh) { rSh.rotation.z = lp(rSh.rotation.z, 0, 0.05); rSh.rotation.x = lp(rSh.rotation.x, 0, 0.05); }
      if (lSh) { lSh.rotation.z = lp(lSh.rotation.z, 0, 0.05); lSh.rotation.x = lp(lSh.rotation.x, 0, 0.05); }
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.07); rUA.rotation.z = lp(rUA.rotation.z, -1.25, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 1.25, 0.07); }
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
    headVibDecay.current.set(head?.position.x ?? 0, head?.position.y ?? 0, head?.position.z ?? 0);
    vrm.update(delta);
  });

  return <group ref={groupRef} position={[0, -1.55, 0]} />;
}

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

const TRACK_BADGE: Record<string, { label: string; cls: string }> = {
  idle:    { label: '📷 Camera Off',   cls: 'text-slate-400  bg-slate-400/10  border-slate-400/30'   },
  loading: { label: '⏳ Loading MP…',  cls: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/40'  },
  ready:   { label: '📷 Camera Ready', cls: 'text-teal-400   bg-teal-400/10   border-teal-400/40'    },
  active:  { label: '🟢 Face Tracking',cls: 'text-lime-400   bg-lime-400/10   border-lime-400/40 animate-pulse' },
  error:   { label: '❌ Track Error',  cls: 'text-rose-400   bg-rose-400/10   border-rose-400/40'    },
};

const EMOTION_LABELS: Record<EmotionMode, string> = { neutral: '😐 Neutral', angry: '😡 Angry', happy: '😊 Happy', sad: '😢 Sad' };
const BEHAVIOR_LABELS: Record<BehaviorMode, string> = { neutral: '😐 Neutral', loudLaugh: '😂 Loud Laugh', shyGiggle: '🙈 Shy Giggle', guilty: '😔 Guilty', angry: '😡 Angry', blush: '☺️ Blush' };
const BEHAVIOR_COLOR: Record<BehaviorMode, BtnColor> = { neutral: 'violet', loudLaugh: 'amber', shyGiggle: 'sky', guilty: 'rose', angry: 'rose', blush: 'lime' };

const AUDIO_BADGE: Record<AudioMode, { label: string; cls: string } | null> = {
  off:   null,
  mic:   { label: '🎤 Mic Active',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' },
  synth: { label: '🔊 Neutral Voice', cls: 'text-violet-400  bg-violet-400/10  border-violet-400/40'  },
  angry: { label: '😡 Angry Voice',   cls: 'text-rose-400    bg-rose-400/10    border-rose-400/40'    },
  happy: { label: '😊 Happy Voice',   cls: 'text-yellow-400  bg-yellow-400/10  border-yellow-400/40'  },
  sad:   { label: '😢 Sad Voice',     cls: 'text-blue-400    bg-blue-400/10    border-blue-400/40'    },
};

export default function AvatarInterviewer() {
  const [emotionMode,  setEmotionMode]  = useState<EmotionMode>('neutral');
  const [behaviorMode, setBehaviorMode] = useState<BehaviorMode>('neutral');
  const [isNodding,    setIsNodding]    = useState(false);
  const [isShaking,    setIsShaking]    = useState(false);
  const [showCamera,   setShowCamera]   = useState(false);

  const { videoRef, trackingRef, status: trackStatus, statusMsg: trackMsg, startTracking, stopTracking } = useMediaPipeTracking();

  // ── Audio (mic / synth / TTS) ─────────────────────────────────────────────
  const voice = useVRMVoice({ onEmotionSuggested: setEmotionMode });
  const {
    analyserRef,
    audioMode, audioError,
    inputText, setInputText, isSpeakingText,
    handleMic, handleStop, handleSynth,
    handleAngryTest, handleHappyTest, handleSadTest,
    handleTTS,
  } = voice;

  const handleNod   = useCallback(() => { if (!isNodding) setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking) setIsShaking(true);  }, [isShaking]);
  const onNodEnd    = useCallback(() => setIsNodding(false),  []);
  const onShakeEnd  = useCallback(() => setIsShaking(false), []);

  const audioBadge   = AUDIO_BADGE[audioMode];
  const trackBadge   = TRACK_BADGE[trackStatus];
  const isTrackActive = trackStatus === 'active';

  return (
    <div className="flex flex-col w-full h-full bg-gradient-to-br from-[#0f0f1a] to-[#1a1a2e]">
      <video ref={videoRef} playsInline muted className="absolute w-0 h-0 opacity-0 pointer-events-none" aria-hidden="true" />
      <div className="flex-1 relative">
        <Canvas camera={{ position: [0, 0.25, 2.4], fov: 38 }} style={{ background: 'transparent' }}>
          <ambientLight intensity={1.1} /> <directionalLight position={[2, 5, 3]} intensity={1.8} castShadow /> <directionalLight position={[-2, 2, -2]} intensity={0.6} color="#aabbff" />
          <Suspense fallback={<LoadingSpinner />}>
            <VRMAvatarMesh analyserRef={analyserRef} trackingRef={trackingRef} emotionMode={emotionMode} behaviorMode={behaviorMode} isNodding={isNodding} isShaking={isShaking} onNodEnd={onNodEnd} onShakeEnd={onShakeEnd} />
          </Suspense>
          <OrbitControls target={[0, 0.1, 0]} minDistance={0.8} maxDistance={6} enablePan={false} />
        </Canvas>
        {audioBadge && <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${audioBadge.cls}`}><span className="w-2 h-2 rounded-full bg-current animate-pulse" />{audioBadge.label}</div>}
        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border text-slate-300 bg-white/5 border-white/10">{EMOTION_LABELS[emotionMode]}</div>
        <div className={`absolute top-14 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${trackBadge.cls}`}>{trackBadge.label}{trackMsg && <span className="text-[10px] opacity-70 ml-1">— {trackMsg}</span>}</div>
        {isTrackActive && trackingRef.current.isBored && <div className="absolute bottom-14 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] text-slate-400 bg-slate-800/60 border border-slate-700/50">😴 Bored idle active</div>}
        {showCamera && isTrackActive && (
          <div className="absolute bottom-4 right-4 group">
            <video ref={node => { if (node && videoRef.current?.srcObject) { node.srcObject = videoRef.current.srcObject; node.play().catch(() => {}); } }} playsInline muted autoPlay className="w-36 h-auto rounded-2xl border-2 border-white/20 shadow-2xl object-cover" style={{ transform: 'scaleX(-1)' }} />
            <button onClick={() => setShowCamera(false)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" title="Hide camera">✕</button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-3">
        {audioError && <p className="text-rose-400 text-xs text-center">{audioError}</p>}
        <div className="flex flex-col items-center gap-2">
          <span className="text-slate-500 text-[10px] uppercase tracking-widest">Behavior</span>
          <div className="flex flex-wrap justify-center gap-1.5">
            {(Object.keys(BEHAVIOR_LABELS) as BehaviorMode[]).map(k => (
              <CtrlBtn key={k} onClick={() => setBehaviorMode(k)} active={behaviorMode === k} color={BEHAVIOR_COLOR[k]}>{BEHAVIOR_LABELS[k]}</CtrlBtn>
            ))}
          </div>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <span className="text-slate-400 text-xs">Emotion:</span>
          <select value={emotionMode} onChange={e => setEmotionMode(e.target.value as EmotionMode)} className="bg-white/5 border border-white/15 text-slate-200 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-violet-400 cursor-pointer">
            {(Object.keys(EMOTION_LABELS) as EmotionMode[]).map(k => <option key={k} value={k}>{EMOTION_LABELS[k]}</option>)}
          </select>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-col items-center gap-2 w-full max-w-md">
          <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Type a sentence here..." className="w-full bg-black/40 border border-white/20 text-white text-xs rounded-lg px-3 py-2 outline-none focus:border-sky-400" />
          <CtrlBtn onClick={handleTTS} active={isSpeakingText} color="sky">🗣️ Speak Text</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={isTrackActive ? stopTracking : startTracking} active={isTrackActive} color="lime">{isTrackActive ? '🟢 Stop Tracking' : '📷 Start Face Tracking'}</CtrlBtn>
          {isTrackActive && <CtrlBtn onClick={() => setShowCamera(v => !v)} active={showCamera} color="sky">{showCamera ? '📹 Hide Camera' : '📹 Show Me'}</CtrlBtn>}
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleMic} active={audioMode==='mic'} color="emerald">🎤 Mic</CtrlBtn>
          <CtrlBtn onClick={handleStop} active={false} color="rose" disabled={audioMode==='off'}>⏹ Stop Audio</CtrlBtn>
          <CtrlBtn onClick={handleSynth} active={audioMode==='synth'} color="violet">🔊 Normal</CtrlBtn>
          <CtrlBtn onClick={handleAngryTest} active={audioMode==='angry'} color="rose">😡 Angry</CtrlBtn>
          <CtrlBtn onClick={handleHappyTest} active={audioMode==='happy'} color="amber">😊 Happy</CtrlBtn>
          <CtrlBtn onClick={handleSadTest} active={audioMode==='sad'} color="sky">😢 Sad</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleNod} active={isNodding} color="sky" disabled={isNodding}>👍 Nod</CtrlBtn>
          <CtrlBtn onClick={handleShake} active={isShaking} color="amber" disabled={isShaking}>👎 Shake</CtrlBtn>
        </div>
      </div>
    </div>
  );
}

type BtnColor = 'emerald' | 'violet' | 'rose' | 'sky' | 'amber' | 'lime';
const CM: Record<BtnColor, { idle: string; active: string }> = { emerald: { idle: 'from-emerald-600 to-teal-600 shadow-emerald-500/25 hover:shadow-emerald-500/45', active: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/40' }, violet: { idle: 'from-indigo-500 to-violet-500 shadow-indigo-500/25 hover:shadow-indigo-500/45', active: 'bg-violet-400/10 text-violet-400 border border-violet-400/40' }, rose: { idle: 'from-rose-600 to-pink-600 shadow-rose-500/25 hover:shadow-rose-500/45', active: 'bg-rose-400/10 text-rose-400 border border-rose-400/40' }, sky: { idle: 'from-sky-500 to-cyan-500 shadow-sky-500/25 hover:shadow-sky-500/45', active: 'bg-sky-400/10 text-sky-400 border border-sky-400/40' }, amber: { idle: 'from-amber-500 to-orange-500 shadow-amber-500/25 hover:shadow-amber-500/45', active: 'bg-amber-400/10 text-amber-400 border border-amber-400/40' }, lime: { idle: 'from-lime-500 to-green-500 shadow-lime-500/25 hover:shadow-lime-500/45', active: 'bg-lime-400/10 text-lime-400 border border-lime-400/40' } };
interface BtnProps { onClick:()=>void; active:boolean; color:BtnColor; disabled?:boolean; children:React.ReactNode }
function CtrlBtn({ onClick, active, color, disabled=false, children }: BtnProps) {
  const c = CM[color];
  return (
    <button onClick={onClick} disabled={disabled} className={`px-4 py-2 rounded-xl font-semibold text-xs tracking-wide transition-all duration-200 ${active ? c.active : disabled ? 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500 border border-white/10' : `bg-gradient-to-r ${c.idle} text-white shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer`}`}>
      {children}
    </button>
  );
}