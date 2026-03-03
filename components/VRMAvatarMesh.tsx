/**
 * VRMAvatarMesh.tsx
 *
 * Standalone Three.js mesh component for the VRM avatar.
 * Owns:
 *   • VRM asset loading (GLTFLoader + VRMLoaderPlugin)
 *   • useFrame loop: face.tick → pose.tick → sequential, no conflicts
 *
 * Does NOT own: audio, UI state, tracking setup — those stay in AvatarInterviewer.
 */
import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import { useVRMFace }  from '../hooks/useVRMFace';
import { useVRMPose }  from '../hooks/useVRMPose';
import type { EmotionMode, BehaviorMode } from '../hooks/useVRMFace';
import type { TrackingData } from '../hooks/useMediaPipeTracking';

const AVATAR_URL = '/Anurag.vrm';

// ─── props ────────────────────────────────────────────────────────────────────
export interface VRMAvatarMeshProps {
  analyserRef:  React.RefObject<AnalyserNode | null>;
  trackingRef:  React.RefObject<TrackingData>;
  emotionMode:  EmotionMode;
  behaviorMode: BehaviorMode;
  isNodding:    boolean;
  isShaking:    boolean;
  onNodEnd:     () => void;
  onShakeEnd:   () => void;
}

// ─── component ────────────────────────────────────────────────────────────────
export function VRMAvatarMesh({
  analyserRef,
  trackingRef,
  emotionMode,
  behaviorMode,
  isNodding,
  isShaking,
  onNodEnd,
  onShakeEnd,
}: VRMAvatarMeshProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const vrmRef   = useRef<VRM | null>(null);

  // ── Face expressions: lip-sync, blendshapes, blinks ──────────────────────
  const face = useVRMFace({ vrmRef, analyserRef, trackingRef, emotionMode, behaviorMode });

  // ── Bone pose: spine, neck/head, arms, jitters ───────────────────────────
  const pose = useVRMPose({
    vrmRef,
    trackingRef,
    emotionMode,
    behaviorMode,
    isNodding,
    isShaking,
    onNodEnd,
    onShakeEnd,
  });

  // ── Load VRM ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));

    loader.load(
      AVATAR_URL,
      gltf => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) return;
        // Assign the look-at target that useVRMPose updates every frame
        vrm.lookAt.target = pose.jitterObj.current;
        groupRef.current.add(vrm.scene);
        vrmRef.current = vrm;
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

  // ── Frame loop ────────────────────────────────────────────────────────────
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const now = state.clock.elapsedTime;

    // Layer 1 — expressions (lip-sync, blendshapes, blinks)
    // Returns speaking flags + smoothed jaw value needed by pose layer
    const { isSpeaking, headReact } = face.tick(now);
    const jawOpen = face.curExpr.current.aa;

    // Layer 2 — bone rotations (spine → neck/head → arms → jitters)
    // vrm.update() is called inside pose.tick to keep it co-located with bones
    pose.tick(delta, now, isSpeaking, headReact, jawOpen);
  });

  return <group ref={groupRef} position={[0, -1.55, 0]} />;
}
