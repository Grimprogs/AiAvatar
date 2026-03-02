import { Suspense, useRef, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AVATAR_URL =
  'https://models.readyplayer.me/69a5e7f58c4f96df517f3654.glb?morphTargets=ARKit';

// Public speech sample — routed through the analyser when "Test AI Voice" is clicked
const AI_SAMPLE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/2/21/Simple_English_Wikipedia.ogg';

useGLTF.preload(AVATAR_URL);

// RMS below this → mouth fully at rest
const SILENCE_RMS = 0.015;
// RMS above ~85 % of the 0.12 normalisation ceiling → ANGRY reaction
const LOUD_THRESHOLD_RMS = 0.12 * 0.85; // ≈ 0.102
// Multiply every normalised [0-1] freq/volume value before clamping to 1
// so subtle mid-range audio produces visible expressions, not micro-twitches.
const EXPRESSION_MULTIPLIER = 3.0;
// Resting smile so the avatar never looks blank / deadpan
const SMILE_BASELINE = 0.25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Average a slice of a byte frequency array, normalised 0-1 */
function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let sum = 0;
  const count = hi - lo;
  for (let i = lo; i < hi; i++) sum += data[i];
  return Math.min(sum / count / 255, 1);
}

// ---------------------------------------------------------------------------
// ARKit morph-target list  (all confirmed present when ?morphTargets=ARKit)
// Includes anger / emotion targets from the full ARKit blend-shape set.
// ---------------------------------------------------------------------------
const TARGETS = [
  // jaw / mouth open-close
  'jawOpen',
  // lip shapes
  'mouthFunnel',
  'mouthPucker',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  // cheeks
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  // eyes + brow
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeWideLeft',
  'eyeWideRight',
  'browInnerUp',
  // anger / frustration (full ARKit set — present with ?morphTargets=ARKit)
  'browDownLeft',
  'browDownRight',
  'noseSneerLeft',
] as const;

type TargetName = (typeof TARGETS)[number];
type MorphMap = Map<TargetName, { mesh: THREE.SkinnedMesh; idx: number }[]>;

// ---------------------------------------------------------------------------
// AvatarMesh  (must live inside <Canvas>)
// ---------------------------------------------------------------------------
interface AvatarMeshProps {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isNodding: boolean;
  isShaking: boolean;
  onNodEnd: () => void;
  onShakeEnd: () => void;
}

function AvatarMesh({ analyserRef, isNodding, isShaking, onNodEnd, onShakeEnd }: AvatarMeshProps) {
  const { scene } = useGLTF(AVATAR_URL);
  const rootRef    = useRef<THREE.Group>(null!);
  const morphMap   = useRef<MorphMap>(new Map());
  const headBone   = useRef<THREE.Object3D | null>(null);

  // Frequency-domain buffer (getByteFrequencyData) + time-domain for RMS
  const freqBuf = useRef<Uint8Array | null>(null);
  const timeBuf = useRef<Uint8Array | null>(null);

  // Per-target smoothed current values — mouth at rest to start
  const current = useRef<Record<TargetName, number>>(
    Object.fromEntries(TARGETS.map((t) => [t, 0])) as Record<TargetName, number>
  );

  // Smoothed RMS so onset detection isn't instantaneous
  const smoothRms = useRef(0);

  // Clock-based blink — absolute elapsedTime for next blink / current blink start
  const nextBlinkTime = useRef(0);   // 0 = not yet initialised (set on first frame)
  const blinkStart    = useRef(-1);  // -1 = not blinking

  // Unified sway phase (advanced once per frame)
  const swayPhase = useRef(Math.random() * Math.PI * 2);

  // Nod / shake timers + "callback fired" guards
  const nodTimer     = useRef(0);
  const shakeTimer   = useRef(0);
  const nodDone      = useRef(false);
  const shakeDone    = useRef(false);
  const wasNodding   = useRef(false);
  const wasShaking   = useRef(false);

  // Angry jitter oscillator phase
  const jitterPhase  = useRef(0);

  // ── Build morph map + locate Head bone once the GLB is loaded ──────────
  useEffect(() => {
    const map: MorphMap = new Map(TARGETS.map((t) => [t, []]));
    scene.traverse((obj) => {
      // Morph targets
      const mesh = obj as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && mesh.morphTargetDictionary) {
        const dict = mesh.morphTargetDictionary;
        for (const name of TARGETS) {
          if (name in dict) map.get(name)!.push({ mesh, idx: dict[name] });
        }
      }
      // Head bone — RPM exports it as "Head" or "mixamorigHead"
      const n = obj.name;
      if (
        (obj instanceof THREE.Bone || obj.type === 'Bone') &&
        (n === 'Head' || n === 'mixamorigHead' || n.toLowerCase() === 'head')
      ) {
        headBone.current = obj;
      }
    });
    morphMap.current = map;
  }, [scene]);

  function setTarget(name: TargetName, value: number) {
    for (const { mesh, idx } of (morphMap.current.get(name) ?? [])) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = value;
    }
  }

  useFrame((state, delta) => {
    const analyser = analyserRef.current;
    const cur = current.current;
    const now = state.clock.elapsedTime;

    // Advance sway phase once per frame
    swayPhase.current += delta * 0.35;

    // ── Resting smile baseline — avatar never looks blank ─────────────────
    const targets: Record<TargetName, number> = Object.fromEntries(
      TARGETS.map((t) => [t, 0])
    ) as Record<TargetName, number>;
    targets.mouthSmileLeft  = SMILE_BASELINE;
    targets.mouthSmileRight = SMILE_BASELINE;

    let isAngry = false;
    let rms = 0;

    // ═══════════════════════════════════════════════════════════════════════
    // 1. AUDIO ANALYSIS  — amplified with EXPRESSION_MULTIPLIER
    // ═══════════════════════════════════════════════════════════════════════
    if (analyser) {
      if (!freqBuf.current) freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuf.current) timeBuf.current = new Uint8Array(analyser.fftSize);

      // ── RMS via time-domain (true amplitude) ────────────────────────────
      analyser.getByteTimeDomainData(timeBuf.current);
      let sumSq = 0;
      for (let i = 0; i < timeBuf.current.length; i++) {
        const s = (timeBuf.current[i] - 128) / 128;
        sumSq += s * s;
      }
      rms = Math.sqrt(sumSq / timeBuf.current.length);
      smoothRms.current = THREE.MathUtils.lerp(smoothRms.current, rms, 0.25);

      // ── 3-BAND FFT SPLIT — raw [0-1], amplified before use ───────────────
      // fftSize=2048 → 1024 bins ≈ 21.5 Hz each
      //   low  (0   – 341)  0–7.3 kHz  : fundamentals, jaw, bass (Ooo)
      //   mid  (341 – 682)  7–14 kHz   : vowel harmonics, cheek engagement
      //   high (682 – 1024) 14–22 kHz  : sibilants, sharp sounds, eye-wide
      analyser.getByteFrequencyData(freqBuf.current);
      const N     = freqBuf.current.length; // 1024
      const third = Math.floor(N / 3);
      // Raw 0-1 values
      const rawLow  = bandAvg(freqBuf.current, 0,         third);
      const rawMid  = bandAvg(freqBuf.current, third,     third * 2);
      const rawHigh = bandAvg(freqBuf.current, third * 2, N);

      // Power-curved volume [0-1], then amplify + clamp
      const rawVol  = Math.min(smoothRms.current / 0.12, 1.5);
      const volume  = THREE.MathUtils.clamp(Math.pow(rawVol, 0.6) * EXPRESSION_MULTIPLIER, 0, 1);
      // Amplified frequency bands — clamp to [0, 1] so mesh is never broken
      const lowFreq  = THREE.MathUtils.clamp(rawLow  * EXPRESSION_MULTIPLIER, 0, 1);
      const midFreq  = THREE.MathUtils.clamp(rawMid  * EXPRESSION_MULTIPLIER, 0, 1);
      const highFreq = THREE.MathUtils.clamp(rawHigh * EXPRESSION_MULTIPLIER, 0, 1);

      // Angry if RMS > 85 % of normalisation ceiling
      isAngry = smoothRms.current >= LOUD_THRESHOLD_RMS;

      // ── VISEME LIP-SYNC (active when above silence floor) ──────────────
      if (smoothRms.current >= SILENCE_RMS) {
        // jawOpen — low+mid drives jaw; shout → wide open
        targets.jawOpen = THREE.MathUtils.clamp(
          (lowFreq * 0.6 + midFreq * 0.4) * volume * 2.4, 0, 0.92
        );

        // viseme_O — rounded /o/ /u/
        targets.mouthFunnel = THREE.MathUtils.clamp(lowFreq * volume * 1.8, 0, 0.90);
        targets.mouthPucker = THREE.MathUtils.clamp(
          lowFreq * Math.max(0, 0.4 - targets.jawOpen) * volume * 2.5, 0, 0.70
        );

        // viseme_SS — sibilants spread lip corners (added to smile baseline)
        targets.mouthSmileLeft  = THREE.MathUtils.clamp(
          SMILE_BASELINE + highFreq * volume * 1.8, 0, 1
        );
        targets.mouthSmileRight = targets.mouthSmileLeft;

        // Lip raise / drop follows jaw
        targets.mouthUpperUpLeft   = THREE.MathUtils.clamp(
          (targets.jawOpen * 0.4 + lowFreq * 0.2) * volume, 0, 0.80
        );
        targets.mouthUpperUpRight  = targets.mouthUpperUpLeft;
        targets.mouthLowerDownLeft = THREE.MathUtils.clamp(
          targets.jawOpen * 0.6 * volume, 0, 0.80
        );
        targets.mouthLowerDownRight = targets.mouthLowerDownLeft;

        // ── CHEEKS ─────────────────────────────────────────────────────────
        // cheekSquint — mid activity + overall volume push cheeks up (speaking effort)
        const squint = THREE.MathUtils.clamp(
          (midFreq * 0.6 + volume * 0.4) * EXPRESSION_MULTIPLIER, 0, 1
        );
        targets.cheekSquintLeft  = squint;
        targets.cheekSquintRight = squint;
        // cheekPuff — bilabials /b/ /p/ /m/; bass (sub-200 Hz) + lowFreq drive it
        targets.cheekPuff = THREE.MathUtils.clamp(
          (bandAvg(freqBuf.current, 0, 10) * EXPRESSION_MULTIPLIER * volume) * 0.5 +
          lowFreq * volume * 0.5,
          0, 0.70
        );

        // ── EYES — widen on sharp / loud high-frequency sounds ─────────────
        targets.eyeWideLeft  = THREE.MathUtils.clamp(highFreq * volume * EXPRESSION_MULTIPLIER, 0, 1);
        targets.eyeWideRight = targets.eyeWideLeft;

        // Brow — syllable-onset spike
        const onset = Math.max(0, rms - smoothRms.current * 0.9);
        targets.browInnerUp = isAngry
          ? 0
          : THREE.MathUtils.clamp(onset * 6.0 * EXPRESSION_MULTIPLIER, 0, 0.80);
      }
      // viseme_PP (closed mouth) is the natural zero state

      // ── ANGRY EMOTION — browDown + noseSneer ───────────────────────────
      if (isAngry) {
        targets.browDownLeft  = 1.0;
        targets.browDownRight = 1.0;
        targets.noseSneerLeft = 1.0;
        targets.browInnerUp   = 0;
        targets.eyeWideLeft   = 0;
        targets.eyeWideRight  = 0;
      }
    } // end if (analyser)

    // ═══════════════════════════════════════════════════════════════════════
    // 2. CLOCK-BASED EYE BLINKS  (every 3–5 s, independent of audio)
    // ═══════════════════════════════════════════════════════════════════════
    // Initialise nextBlinkTime on the very first frame
    if (nextBlinkTime.current === 0) {
      nextBlinkTime.current = now + Math.random() * 2 + 2;
    }
    // Schedule a new blink when the clock passes nextBlinkTime
    if (blinkStart.current < 0 && now >= nextBlinkTime.current) {
      blinkStart.current    = now;
      nextBlinkTime.current = now + Math.random() * 2 + 3; // 3–5 s until next blink
    }
    // Animate the blink (open → closed → open over 130 ms)
    if (blinkStart.current >= 0) {
      const HALF    = 0.065;                   // 65 ms per half
      const elapsed = now - blinkStart.current;
      const v       = elapsed < HALF
        ? elapsed / HALF
        : Math.max(0, 1 - (elapsed - HALF) / HALF);
      targets.eyeBlinkLeft  = v;
      targets.eyeBlinkRight = v;
      if (elapsed >= HALF * 2) blinkStart.current = -1;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. LERP ALL MORPH TARGETS — slightly faster alpha (~0.20) for snappier
    //    response to the amplified audio values
    // ═══════════════════════════════════════════════════════════════════════
    const alphas: Record<TargetName, number> = {
      jawOpen:              0.32,
      mouthFunnel:          0.22,
      mouthPucker:          0.20,
      mouthSmileLeft:       0.20,
      mouthSmileRight:      0.20,
      mouthUpperUpLeft:     0.24,
      mouthUpperUpRight:    0.24,
      mouthLowerDownLeft:   0.26,
      mouthLowerDownRight:  0.26,
      cheekPuff:            0.20,
      cheekSquintLeft:      0.20,
      cheekSquintRight:     0.20,
      eyeBlinkLeft:         0.90,
      eyeBlinkRight:        0.90,
      eyeWideLeft:          0.22,
      eyeWideRight:         0.22,
      browInnerUp:          0.20,
      browDownLeft:         0.18,
      browDownRight:        0.18,
      noseSneerLeft:        0.18,
    };

    for (const name of TARGETS) {
      cur[name] = THREE.MathUtils.lerp(cur[name], targets[name], alphas[name]);
      setTarget(name, cur[name]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. HEAD BONE ANIMATIONS  (nod / shake / idle sway / angry jitter)
    // ═══════════════════════════════════════════════════════════════════════
    const head = headBone.current;
    if (head) {
      const NOD_DURATION   = 2.0;
      const SHAKE_DURATION = 2.0;

      // Rising-edge detection — reset timer & guard when animation starts
      if (isNodding && !wasNodding.current) {
        nodTimer.current = 0;
        nodDone.current  = false;
      }
      if (isShaking && !wasShaking.current) {
        shakeTimer.current = 0;
        shakeDone.current  = false;
      }
      wasNodding.current  = isNodding;
      wasShaking.current  = isShaking;

      if (isNodding) {
        // Yes — sine wave on X-axis for 2 s
        nodTimer.current += delta;
        if (nodTimer.current < NOD_DURATION) {
          head.rotation.x = Math.sin(nodTimer.current * Math.PI * 2.5) * 0.22;
          head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, 0, 0.08);
          head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0, 0.08);
        } else {
          head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0, 0.10);
          if (!nodDone.current) { nodDone.current = true; onNodEnd(); }
        }
      } else if (isShaking) {
        // No — sine wave on Y-axis for 2 s
        shakeTimer.current += delta;
        if (shakeTimer.current < SHAKE_DURATION) {
          head.rotation.y = Math.sin(shakeTimer.current * Math.PI * 3.5) * 0.22;
          head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0, 0.08);
          head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0, 0.08);
        } else {
          head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, 0, 0.10);
          if (!shakeDone.current) { shakeDone.current = true; onShakeEnd(); }
        }
      } else {
        // Idle — very slow, subtle breathing sway
        const speaking = (cur.jawOpen ?? 0) > 0.05 ? 1 : 0;
        const amt      = 0.012 + speaking * 0.008;
        head.rotation.x = THREE.MathUtils.lerp(
          head.rotation.x, Math.sin(swayPhase.current * 0.60) * amt, 0.04
        );
        head.rotation.y = THREE.MathUtils.lerp(
          head.rotation.y, Math.sin(swayPhase.current * 0.43) * amt * 0.7, 0.04
        );
        head.rotation.z = THREE.MathUtils.lerp(
          head.rotation.z, Math.sin(swayPhase.current) * amt * 0.4, 0.04
        );
      }

      // Additive angry Z-jitter (fast shiver of frustration)
      if (isAngry) {
        jitterPhase.current += delta * 28;
        head.rotation.z += Math.sin(jitterPhase.current) * 0.04;
      } else {
        jitterPhase.current = 0;
      }
    }

    // ── Root idle body sway (subtle, unrelated to head bone) ──────────────
    if (rootRef.current) {
      const amt = 0.003;
      rootRef.current.rotation.z = Math.sin(swayPhase.current)        * amt;
      rootRef.current.rotation.x = Math.sin(swayPhase.current * 0.58) * amt * 0.4;
    }
  });

  return (
    <group ref={rootRef}>
      <primitive object={scene} position={[0, -1.6, 0]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Suspense fallback – rotating wireframe torus shown while the GLB loads
// ---------------------------------------------------------------------------
function LoadingSpinner() {
  const meshRef = useRef<THREE.Mesh>(null!);
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.x += delta * 1.2;
      meshRef.current.rotation.y += delta * 0.8;
    }
  });
  return (
    <mesh ref={meshRef}>
      <torusGeometry args={[0.5, 0.1, 16, 60]} />
      <meshStandardMaterial color="#6366f1" wireframe />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Shared AudioContext + AnalyserNode helpers for AvatarInterviewer
// ---------------------------------------------------------------------------
type AudioMode = 'off' | 'mic' | 'ai';

// ---------------------------------------------------------------------------
// AvatarInterviewer  (exported page-level component)
// ---------------------------------------------------------------------------
export default function AvatarInterviewer() {
  const [audioMode,  setAudioMode]  = useState<AudioMode>('off');
  const [isNodding,  setIsNodding]  = useState(false);
  const [isShaking,  setIsShaking]  = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Shared Web Audio objects
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const audioCtxRef      = useRef<AudioContext | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const micSourceRef     = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioElRef       = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef   = useRef<MediaElementAudioSourceNode | null>(null);

  // ── Ensure a shared AudioContext + AnalyserNode exists ─────────────────
  const ensureCtx = useCallback((): { ctx: AudioContext; analyser: AnalyserNode } => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx     = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize              = 2048;
      analyser.smoothingTimeConstant = 0.45;
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return { ctx: audioCtxRef.current, analyser: analyserRef.current! };
  }, []);

  // ── Tear down any currently active audio source ─────────────────────────
  const stopCurrentSource = useCallback(() => {
    // Mic
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    // AI audio element
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    mediaSourceRef.current?.disconnect();
    // Note: we intentionally do NOT null mediaSourceRef so WA doesn't
    // throw on re-connect (MediaElementAudioSourceNode can be reconnected)
  }, []);

  // ── ENABLE MIC ──────────────────────────────────────────────────────────
  const handleEnableMic = useCallback(async () => {
    setAudioError(null);
    stopCurrentSource();
    try {
      const { ctx, analyser } = ensureCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      streamRef.current    = stream;
      micSourceRef.current = source;
      setAudioMode('mic');
    } catch {
      setAudioError('Microphone access denied — allow permissions and try again.');
    }
  }, [ensureCtx, stopCurrentSource]);

  // ── TEST AI VOICE ────────────────────────────────────────────────────────
  const handleTestAI = useCallback(() => {
    setAudioError(null);
    stopCurrentSource();
    const { ctx, analyser } = ensureCtx();

    // Create audio element on first use.
    // crossOrigin MUST be set BEFORE the src attribute so the browser sends
    // the CORS request headers before it starts loading the media.
    if (!audioElRef.current) {
      const el = document.createElement('audio');
      el.crossOrigin = 'anonymous';
      el.src  = AI_SAMPLE_URL;
      el.loop = true;
      audioElRef.current = el;
    }

    // MediaElementAudioSourceNode can only be created once per element.
    // On subsequent calls we just reconnect the existing node.
    if (!mediaSourceRef.current) {
      const src = ctx.createMediaElementSource(audioElRef.current);
      src.connect(analyser);
      mediaSourceRef.current = src;
    } else {
      try { mediaSourceRef.current.connect(analyser); } catch { /* already connected */ }
    }

    // Always ensure analyser feeds the speakers.
    // Wrapped in try/catch because Web Audio throws if the connection already exists.
    try { analyser.connect(ctx.destination); } catch { /* already connected */ }

    audioElRef.current.play().catch((err: unknown) => {
      console.error('AI audio play failed:', err);
      setAudioError('Could not play sample audio — check your browser\'s autoplay policy.');
    });
    setAudioMode('ai');
  }, [ensureCtx, stopCurrentSource]);

  // ── STOP ALL AUDIO ───────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    stopCurrentSource();
    setAudioMode('off');
  }, [stopCurrentSource]);

  // ── Nod / Shake callbacks ────────────────────────────────────────────────
  const handleNod   = useCallback(() => { if (!isNodding) setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking) setIsShaking(true);  }, [isShaking]);
  const onNodEnd    = useCallback(() => setIsNodding(false), []);
  const onShakeEnd  = useCallback(() => setIsShaking(false), []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCurrentSource();
      audioCtxRef.current?.close();
    };
  }, [stopCurrentSource]);

  // ── Status badge text ────────────────────────────────────────────────────
  const badge =
    audioMode === 'mic' ? { label: '🎤 Mic Active',      cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' } :
    audioMode === 'ai'  ? { label: '🤖 AI Voice Active', cls: 'text-violet-400  bg-violet-400/10  border-violet-400/40'  } :
    null;

  return (
    <div className="flex flex-col w-full h-full bg-gradient-to-br from-[#0f0f1a] to-[#1a1a2e]">
      {/* 3-D canvas -------------------------------------------------------- */}
      <div className="flex-1 relative">
        <Canvas
          camera={{ position: [0, 0.2, 2.2], fov: 40 }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.9} />
          <directionalLight position={[2, 5, 3]} intensity={1.8} castShadow />
          <directionalLight position={[-2, 2, -2]} intensity={0.5} color="#aabbff" />

          <Suspense fallback={<LoadingSpinner />}>
            <AvatarMesh
              analyserRef={analyserRef}
              isNodding={isNodding}
              isShaking={isShaking}
              onNodEnd={onNodEnd}
              onShakeEnd={onShakeEnd}
            />
          </Suspense>

          <OrbitControls
            target={[0, 0.1, 0]}
            minDistance={0.8}
            maxDistance={6}
            enablePan={false}
          />
        </Canvas>

        {/* Audio mode badge */}
        {badge && (
          <div className={`absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${badge.cls}`}>
            <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
            {badge.label}
          </div>
        )}

        {/* Drag hint */}
        {audioMode === 'off' && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-500 pointer-events-none">
            Avatar loading… · Drag to orbit · Scroll to zoom
          </div>
        )}
      </div>

      {/* ── Control Panel ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-4">

        {audioError && (
          <p className="text-rose-400 text-xs text-center">{audioError}</p>
        )}

        {/* Row 1 — Audio routing */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn
            onClick={handleEnableMic}
            active={audioMode === 'mic'}
            color="emerald"
          >
            🎤 Enable My Mic
          </CtrlBtn>

          <CtrlBtn
            onClick={handleTestAI}
            active={audioMode === 'ai'}
            color="violet"
          >
            🤖 Test AI Voice
          </CtrlBtn>

          <CtrlBtn
            onClick={handleStop}
            active={false}
            color="rose"
            disabled={audioMode === 'off'}
          >
            ⏹ Stop Audio
          </CtrlBtn>
        </div>

        {/* Divider */}
        <div className="w-full h-px bg-white/5" />

        {/* Row 2 — Head animation triggers */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn
            onClick={handleNod}
            active={isNodding}
            color="sky"
            disabled={isNodding}
          >
            👍 Nod Yes
          </CtrlBtn>

          <CtrlBtn
            onClick={handleShake}
            active={isShaking}
            color="amber"
            disabled={isShaking}
          >
            👎 Shake No
          </CtrlBtn>
        </div>

        <p className="text-slate-600 text-[10px] text-center leading-relaxed">
          Mic: speak loudly (&gt; 85 % vol) to trigger the angry reaction · AI sample loops until stopped
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small reusable button — keeps JSX above DRY
// ---------------------------------------------------------------------------
type BtnColor = 'emerald' | 'violet' | 'rose' | 'sky' | 'amber';
const colorMap: Record<BtnColor, { idle: string; active: string }> = {
  emerald: {
    idle:   'from-emerald-600 to-teal-600 shadow-emerald-500/25 hover:shadow-emerald-500/45',
    active: 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/40',
  },
  violet: {
    idle:   'from-indigo-500 to-violet-500 shadow-indigo-500/25 hover:shadow-indigo-500/45',
    active: 'bg-violet-400/10 text-violet-400 border border-violet-400/40',
  },
  rose: {
    idle:   'from-rose-600 to-pink-600 shadow-rose-500/25 hover:shadow-rose-500/45',
    active: 'bg-rose-400/10 text-rose-400 border border-rose-400/40',
  },
  sky: {
    idle:   'from-sky-500 to-cyan-500 shadow-sky-500/25 hover:shadow-sky-500/45',
    active: 'bg-sky-400/10 text-sky-400 border border-sky-400/40',
  },
  amber: {
    idle:   'from-amber-500 to-orange-500 shadow-amber-500/25 hover:shadow-amber-500/45',
    active: 'bg-amber-400/10 text-amber-400 border border-amber-400/40',
  },
};

interface CtrlBtnProps {
  onClick: () => void;
  active: boolean;
  color: BtnColor;
  disabled?: boolean;
  children: React.ReactNode;
}

function CtrlBtn({ onClick, active, color, disabled = false, children }: CtrlBtnProps) {
  const c = colorMap[color];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        px-5 py-2.5 rounded-xl font-semibold text-xs tracking-wide transition-all duration-200
        ${active
          ? c.active
          : disabled
            ? 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500 border border-white/10'
            : `bg-gradient-to-r ${c.idle} text-white shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer`
        }
      `}
    >
      {children}
    </button>
  );
}
