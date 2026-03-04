import React, { Suspense, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { VRMLoaderPlugin, VRMHumanBoneName, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useVRMFace } from '../hooks/useVRMFace';
import { useVRMPose } from '../hooks/useVRMPose';
import { useMediaPipeTracking, type TrackingData } from '../hooks/useMediaPipeTracking';

/*
  AvatarInterviewer.tsx — annotated

  This file provides a small embedded avatar preview using a VRM model.
  Key concepts and flow:
  - `useMediaPipeTracking` manages webcam + MediaPipe face tracking and exposes
    a `trackingRef` (used by face/pose hooks) and a `videoRef` for capture.
  - `useVRMFace` computes and applies VRM expression blendshapes each frame.
  - `useVRMPose` drives bone rotations (neck, arms, chest) and exposes a
    `jitterObj` used as the VRM lookAt target.
  - `VRMHead` loads the VRM and runs a per-frame loop: face.tick -> pose.tick -> vrm.update
  - The exported component is a `forwardRef` wrapper that exposes `captureWebcamFrame`
    via `useImperativeHandle` so callers can snapshot the webcam from the parent.
*/

interface AvatarInterviewerProps {
  speechLevel: number;
  isLiveConnected: boolean;
}

export interface AvatarInterviewerHandle {
  captureWebcamFrame: () => string | null;
}

function VRMHead({ speechLevel, trackingRef }: { speechLevel: number; trackingRef: React.RefObject<TrackingData> }) {
  // `rootRef` is the Three.js group that will receive the VRM scene once loaded.
  const rootRef = useRef<THREE.Group>(null);
  // `vrmRef` holds the loaded VRM instance so the frame loop can update it.
  const vrmRef = useRef<VRM | null>(null);

  // Face hook: handles expressions (visemes, blinks) and exposes a `tick(now, delta)`.
  // We pass `speechLevel` so the face logic can bias lip-sync intensity.
  const face = useVRMFace({
    vrmRef,
    trackingRef,
    emotionMode: 'neutral',
    behaviorMode: 'neutral',
    speechLevel
  });

  // Pose hook: bone rotations and look-at jitter. It exposes `tick(delta, now, ...)`
  // and a `jitterObj` which we assign to `vrm.lookAt.target` after loading.
  const pose = useVRMPose({
    vrmRef,
    trackingRef,
    emotionMode: 'neutral',
    behaviorMode: 'neutral',
    isNodding: false,
    isShaking: false,
    onNodEnd: () => { },
    onShakeEnd: () => { }
  });

  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      '/Anurag.vrm',
      (gltf) => {
        // The VRM loader attaches the VRM instance to `gltf.userData.vrm`.
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm || !rootRef.current) return;

        // Wire the lookAt target to the pose jitter object so the head follows it.
        if (pose.jitterObj.current) {
          vrm.lookAt.target = pose.jitterObj.current;
        }

        // Add the VRM scene to our group and keep a reference for updates.
        rootRef.current.add(vrm.scene);
        vrmRef.current = vrm;
      },
      undefined,
      (err) => {
        console.error('Failed to load VRM', err);
      }
    );

    return () => {
      if (vrmRef.current && rootRef.current) {
        rootRef.current.remove(vrmRef.current.scene);
      }
      vrmRef.current = null;
    };
  }, []);

  // The per-frame update: compute expressions first, then apply bone pose.
  // Order matters so expressions (jaw open) can influence pose reactions.
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;
    const now = state.clock.elapsedTime;

    // face.tick returns `isSpeaking`/`headReact` and a smoothed jaw value (`curAa`).
    const { isSpeaking, headReact, curAa } = face.tick(now, delta);
    // Pose uses the jaw value and speaking flags to drive neck/head/arm motion.
    pose.tick(delta, now, isSpeaking, headReact, curAa);

    // Finally, let the VRM internal driver update skeleton/blendshapes.
    vrm.update(delta);
  });

  return <group ref={rootRef} position={[0, -1.56, 0]} />;
}

const AvatarInterviewer = forwardRef<AvatarInterviewerHandle, AvatarInterviewerProps>(({ speechLevel, isLiveConnected }, ref) => {
  // Start the tracking pipeline immediately when this component mounts.
  const tracking = useMediaPipeTracking();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    tracking.startTracking();
    return () => { tracking.stopTracking(); };
  }, [tracking.startTracking, tracking.stopTracking]);

  // Expose an imperative API so parent components can request a webcam snapshot.
  // `captureWebcamFrame` draws the hidden `<video>` into a `<canvas>` and returns
  // a base64 JPEG payload (without the data: prefix).
  useImperativeHandle(ref, () => ({
    captureWebcamFrame: () => {
      const video = tracking.videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    }
  }));

  // Render a small embedded 3D canvas containing the VRM head. The `tracking.videoRef`
  // and `canvasRef` remain hidden — they are only used for capture and for the
  // tracking pipeline; the visible UI is the 3D Canvas and a small status label.
  return (
    <section className="pointer-events-none absolute right-4 top-4 z-20 h-[210px] w-[210px] sm:h-[260px] sm:w-[260px] lg:h-[320px] lg:w-[320px] overflow-hidden rounded-2xl border border-subtle bg-panel/85 shadow-lg">
      {/* Hidden video/canvas used by MediaPipe and capture API */}
      <video ref={tracking.videoRef} playsInline muted className="hidden" />
      <canvas ref={canvasRef} className="hidden" />

      <Canvas camera={{ position: [0, 0, 1], fov: 25 }} style={{ background: 'transparent' }}>
        <ambientLight intensity={1.05} />
        <directionalLight position={[2, 4, 3]} intensity={1.2} />
        <directionalLight position={[-2, 1.5, -2]} intensity={0.5} color="#b8c4ff" />
        <Suspense fallback={null}>
          {/* VRMHead contains the VRM load + per-frame face/pose ticks */}
          <VRMHead speechLevel={speechLevel} trackingRef={tracking.trackingRef} />
        </Suspense>
      </Canvas>

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] uppercase text-secondary/80">
        {isLiveConnected ? 'Listening' : 'Interviewer'}
      </div>
    </section>
  );
});

export default AvatarInterviewer;
