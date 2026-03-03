import React, { Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { VRMHumanBoneName, VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface AvatarInterviewerProps {
  speechLevel: number;
  isLiveConnected: boolean;
}

function VRMHead({ speechLevel }: { speechLevel: number }) {
  const rootRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const speechRef = useRef(0);

  useEffect(() => {
    speechRef.current = speechLevel;
  }, [speechLevel]);

  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      '/Anurag.vrm',
      (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm || !rootRef.current) return;
        rootRef.current.add(vrm.scene);
        vrmRef.current = vrm;
      },
      undefined,
      () => {
        // Keep a silent failure path so the rest of the app remains usable.
      },
    );

    return () => {
      if (vrmRef.current && rootRef.current) {
        rootRef.current.remove(vrmRef.current.scene);
      }
      vrmRef.current = null;
    };
  }, []);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const target = THREE.MathUtils.clamp(speechRef.current * 2.35, 0, 1);
    const currentAa = vrm.expressionManager?.getValue('aa') ?? 0;
    const aa = THREE.MathUtils.damp(currentAa, target, target > currentAa ? 12 : 7, delta);

    vrm.expressionManager?.setValue('aa', aa);
    vrm.expressionManager?.setValue('ee', aa * 0.58);
    vrm.expressionManager?.setValue('ih', aa * 0.45);
    vrm.expressionManager?.setValue('oh', aa * 0.62);
    vrm.expressionManager?.setValue('ou', aa * 0.4);
    vrm.expressionManager?.setValue('happy', aa * 0.18);
    vrm.expressionManager?.setValue('blink', 0);
    vrm.expressionManager?.update();

    const head = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
    const neck = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const rSh = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    const lSh = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rUA = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const lUA = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const rLA = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    const lLA = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rHand = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightHand);
    const lHand = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
    if (head && neck) {
      const t = state.clock.elapsedTime;
      const nod = Math.sin(t * 5.2) * aa * 0.06 + aa * 0.05;
      const sway = Math.sin(t * 2.1) * 0.02;
      head.rotation.x = THREE.MathUtils.damp(head.rotation.x, nod, 10, delta);
      head.rotation.y = THREE.MathUtils.damp(head.rotation.y, sway, 8, delta);
      neck.rotation.x = THREE.MathUtils.damp(neck.rotation.x, nod * 0.55, 8, delta);
      neck.rotation.y = THREE.MathUtils.damp(neck.rotation.y, sway * 0.5, 8, delta);
    }

    // Hard-lock to neutral standing rest pose (prevents arm drift/raised hands).
    if (rSh) {
      rSh.rotation.x = 0;
      rSh.rotation.y = 0;
      rSh.rotation.z = 0;
    }
    if (lSh) {
      lSh.rotation.x = 0;
      lSh.rotation.y = 0;
      lSh.rotation.z = 0;
    }
    if (rUA) {
      rUA.rotation.x = 3;
      rUA.rotation.y = -1;
      rUA.rotation.z = -1.5;
    }
    if (lUA) {
      lUA.rotation.x = 3;
      lUA.rotation.y = 0;
      lUA.rotation.z = 1.35;
    }
    if (rLA) {
      rLA.rotation.x = 0;
      rLA.rotation.y = 0;
      rLA.rotation.z = 0;
    }
    if (lLA) {
      lLA.rotation.x = 0;
      lLA.rotation.y = 0;
      lLA.rotation.z = 0;
    }
    if (rHand) {
      rHand.rotation.x = 0;
      rHand.rotation.y = 0;
      rHand.rotation.z = 0;
    }
    if (lHand) {
      lHand.rotation.x = 0;
      lHand.rotation.y = 0;
      lHand.rotation.z = 0;
    }

    vrm.update(delta);
  });

  return <group ref={rootRef} position={[0, -1.56, 0]} />;
}

export default function AvatarInterviewer({ speechLevel, isLiveConnected }: AvatarInterviewerProps) {
  return (
    <section className="pointer-events-none absolute right-4 top-4 z-20 h-[210px] w-[210px] sm:h-[260px] sm:w-[260px] lg:h-[320px] lg:w-[320px] overflow-hidden rounded-2xl border border-subtle bg-panel/85 shadow-lg">
      <Canvas camera={{ position: [0, 0, 1], fov: 25 }} style={{ background: 'transparent' }}>
        <ambientLight intensity={1.05} />
        <directionalLight position={[2, 4, 3]} intensity={1.2} />
        <directionalLight position={[-2, 1.5, -2]} intensity={0.5} color="#b8c4ff" />
        <Suspense fallback={null}>
          <VRMHead speechLevel={speechLevel} />
        </Suspense>
      </Canvas>

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] uppercase text-secondary/80">
        {isLiveConnected ? 'Listening' : 'Interviewer'}
      </div>
    </section>
  );
}
