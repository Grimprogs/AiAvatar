/**
 * AvatarInterviewer.tsx  — VRM avatar with Web Audio lip-sync (full rewrite)
 *
 * Fixes:
 *  1. Sample voice uses a local Web Audio oscillator (no broken external URL)
 *  2. Head/neck sway is ONLY active when the avatar is NOT speaking; speech
 *     drives bone pose directly so the two never fight each other
 *  3. Arm gestures use VRMHumanBoneName enum values; bone names logged on load
 *     so you can verify in the console if they're missing from the VRM
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

// ─── tunables ───────────────────────────────────────────────────────────────
const AVATAR_URL        = '/Anurag.vrm';
const SILENCE_RMS       = 0.015;   // below this → fully silent
const SHOUT_RMS         = 0.10;    // above this → angry reaction
const BAND_AMP          = 2.4;     // scale raw [0-1] band values
const IDLE_SWAY_AMP     = 0.012;   // amplitude of idle head micro-sway
// ────────────────────────────────────────────────────────────────────────────

function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += data[i];
  return Math.min(s / (hi - lo) / 255, 1);
}
const lp = THREE.MathUtils.lerp;
const cl = THREE.MathUtils.clamp;

// ─── expression keys we actually drive ──────────────────────────────────────
type EK = 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'blink' | 'angry' | 'happy';

// ─── VRMAvatarMesh ───────────────────────────────────────────────────────────
interface MeshProps {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isNodding:  boolean;
  isShaking:  boolean;
  onNodEnd:   () => void;
  onShakeEnd: () => void;
}

function VRMAvatarMesh({ analyserRef, isNodding, isShaking, onNodEnd, onShakeEnd }: MeshProps) {
  const { camera } = useThree();
  const groupRef   = useRef<THREE.Group>(null!);
  const vrmRef     = useRef<VRM | null>(null);

  // audio buffers
  const freqBuf  = useRef<Uint8Array | null>(null);
  const timeBuf  = useRef<Uint8Array | null>(null);
  const sRms     = useRef(0);          // smoothed RMS

  // per-expression smoothed current values
  const curExpr = useRef<Record<EK, number>>({
    aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0,
  });

  // blink clock
  const nextBlink = useRef(0);
  const blinkT    = useRef(-1);

  // idle sway phase
  const swP = useRef(Math.random() * Math.PI * 2);

  // nod / shake state
  const nodT     = useRef(0);
  const shakeT   = useRef(0);
  const nodDone  = useRef(false);
  const shakeDone= useRef(false);
  const prevNod  = useRef(false);
  const prevShake= useRef(false);

  // angry jitter
  const jitP = useRef(0);

  // ── load VRM ────────────────────────────────────────────────────────────
  useEffect(() => {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));

    loader.load(
      AVATAR_URL,
      gltf => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) { console.error('[VRM] no vrm in userData'); return; }

        vrm.lookAt.target = camera;
        groupRef.current.add(vrm.scene);
        vrmRef.current = vrm;

        // ── debug: list every humanoid bone present ──
        console.groupCollapsed('[VRM] humanoid bones');
        for (const name of Object.values(VRMHumanBoneName)) {
          const raw  = vrm.humanoid.getRawBoneNode(name);
          const norm = vrm.humanoid.getNormalizedBoneNode(name);
          if (raw || norm) console.log(name, { raw: raw?.name, norm: norm?.name });
        }
        console.groupEnd();

        // ── debug: list every expression present ──
        console.groupCollapsed('[VRM] expressions');
        // @ts-ignore – expressionMap is not typed in all versions
        const exprMap = vrm.expressionManager?.expressionMap ?? {};
        for (const k of Object.keys(exprMap)) console.log(k);
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

  // ── per-frame ────────────────────────────────────────────────────────────
  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;

    const now = state.clock.elapsedTime;
    swP.current += delta * 0.30;

    // ════════════════════════════════════════════════════════════════════════
    // 1. AUDIO  →  build expression targets
    // ════════════════════════════════════════════════════════════════════════
    const tgt: Record<EK, number> = {
      aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0.10,
    };

    let isSpeaking = false;
    let isAngry    = false;

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
      sRms.current = lp(sRms.current, rms, 0.30);

      isSpeaking = sRms.current > SILENCE_RMS;
      isAngry    = sRms.current > SHOUT_RMS;

      if (isSpeaking) {
        // frequency bands
        analyser.getByteFrequencyData(freqBuf.current);
        const N = freqBuf.current.length;
        const t = Math.floor(N / 3);

        // raw 0-1 per band
        const rL = bandAvg(freqBuf.current, 0,   t);
        const rM = bandAvg(freqBuf.current, t,   t*2);
        const rH = bandAvg(freqBuf.current, t*2, N);

        // proportional volume (0-1, power-curved so quiet still reads)
        const vol = Math.pow(cl(sRms.current / 0.12, 0, 1), 0.70);

        // amplified bands
        const low  = cl(rL * BAND_AMP, 0, 1);
        const mid  = cl(rM * BAND_AMP, 0, 1);
        const high = cl(rH * BAND_AMP, 0, 1);

        // A-E-I-O-U visemes
        tgt.aa = cl(mid  * vol * 1.40, 0, 1);            // Ah  — jaw open
        tgt.ee = cl(mid  * vol * 0.75, 0, 1);            // Eh  — spread lips
        tgt.ih = cl(high * vol * 1.10, 0, 1);            // Ee  — tense
        tgt.oh = cl(low  * vol * 1.10, 0, 1);            // Oh  — rounded
        tgt.ou = cl(low  * Math.max(0, 0.45 - tgt.aa) * vol * 1.60, 0, 1); // Oo

        // happy scales with high-freq brightness at moderate volume
        // (bright voice = cheerful; suppressed when angry)
        tgt.happy = cl(high * vol * 0.90, 0, 0.85);

        if (isAngry) {
          tgt.angry = 1.0;
          tgt.happy = 0;
          tgt.aa    = cl(tgt.aa * 1.3, 0, 1); // shout mouth even wider
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2. BLINKS  (every 3.5-5 s, independent of speech)
    // ════════════════════════════════════════════════════════════════════════
    if (nextBlink.current === 0) nextBlink.current = now + 2 + Math.random() * 2;
    if (blinkT.current < 0 && now >= nextBlink.current) {
      blinkT.current  = now;
      nextBlink.current = now + 3.5 + Math.random() * 1.5;
    }
    if (blinkT.current >= 0) {
      const HALF = 0.07;
      const el   = now - blinkT.current;
      tgt.blink  = el < HALF ? el / HALF : Math.max(0, 1 - (el - HALF) / HALF);
      if (el >= HALF * 2) blinkT.current = -1;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3. LERP + APPLY all expressions
    // ════════════════════════════════════════════════════════════════════════
    const ALPHA: Record<EK, number> = {
      aa:0.30, ee:0.22, ih:0.22, oh:0.25, ou:0.20,
      blink:0.90, angry:0.18, happy:0.14,
    };
    for (const k of Object.keys(tgt) as EK[]) {
      curExpr.current[k] = lp(curExpr.current[k], tgt[k], ALPHA[k]);
      setExpr(k, curExpr.current[k]);
    }
    vrm.expressionManager?.update();

    // ════════════════════════════════════════════════════════════════════════
    // 4. BONES
    // ════════════════════════════════════════════════════════════════════════
    const h = vrm.humanoid;

    // ── Neck + Head ────────────────────────────────────────────────────────
    const neck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);

    if (neck && head) {
      // rising-edge guards for nod / shake
      if ( isNodding && !prevNod.current)   { nodT.current   = 0; nodDone.current   = false; }
      if ( isShaking && !prevShake.current) { shakeT.current = 0; shakeDone.current = false; }
      prevNod.current   = isNodding;
      prevShake.current = isShaking;

      if (isAngry) {
        // ── SHOUT: head tilts back + fast Z-jitter ─────────────────────
        neck.rotation.x = lp(neck.rotation.x, -0.20, 0.12);
        neck.rotation.z = lp(neck.rotation.z,  0.10, 0.10);
        head.rotation.x = lp(head.rotation.x, -0.12, 0.12);
        jitP.current += delta * 28;
        head.rotation.z += Math.sin(jitP.current) * 0.03;

      } else if (isNodding) {
        // ── NOD ────────────────────────────────────────────────────────
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
        // ── SHAKE ──────────────────────────────────────────────────────
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

      } else if (isSpeaking) {
        // ── SPEAKING: small rhythmic movement driven by jaw value ──────
        jitP.current = 0;
        const jaw = curExpr.current.aa;
        const spk = Math.sin(now * 3.5) * jaw * 0.04;
        head.rotation.x = lp(head.rotation.x, -jaw * 0.06 + spk, 0.08);
        head.rotation.y = lp(head.rotation.y, 0, 0.06);
        head.rotation.z = lp(head.rotation.z, 0, 0.06);
        neck.rotation.x = lp(neck.rotation.x, -jaw * 0.04, 0.06);
        neck.rotation.z = lp(neck.rotation.z, 0, 0.06);

      } else {
        // ── IDLE: very subtle sway ONLY when silent ────────────────────
        jitP.current = 0;
        const s = swP.current;
        neck.rotation.x = lp(neck.rotation.x, Math.sin(s * 0.53) * IDLE_SWAY_AMP,         0.025);
        neck.rotation.z = lp(neck.rotation.z, Math.sin(s * 0.37) * IDLE_SWAY_AMP * 0.5,   0.025);
        head.rotation.x = lp(head.rotation.x, Math.sin(s * 0.61) * IDLE_SWAY_AMP * 1.2,   0.030);
        head.rotation.y = lp(head.rotation.y, Math.sin(s * 0.44) * IDLE_SWAY_AMP * 0.7,   0.030);
        head.rotation.z = lp(head.rotation.z, Math.sin(s       ) * IDLE_SWAY_AMP * 0.35,  0.030);
      }
    }

    // ── Arms — ONLY animate while speaking ────────────────────────────────
    const rUA = h.getRawBoneNode(VRMHumanBoneName.RightUpperArm);
    const rLA = h.getRawBoneNode(VRMHumanBoneName.RightLowerArm);
    const lUA = h.getRawBoneNode(VRMHumanBoneName.LeftUpperArm);
    const lLA = h.getRawBoneNode(VRMHumanBoneName.LeftLowerArm);

    if (isSpeaking) {
      const b1 = Math.sin(now * 3.2)              * 0.14;  // bounce cadence
      const b2 = Math.sin(now * 3.2 + Math.PI*.5) * 0.11;  // offset phase

      if (rUA) {
        rUA.rotation.x = lp(rUA.rotation.x, -0.45,       0.10);
        rUA.rotation.z = lp(rUA.rotation.z, -0.22,       0.10);
      }
      if (rLA) {
        rLA.rotation.x = lp(rLA.rotation.x, -0.30 + b1,  0.13);
      }
      if (lUA) {
        lUA.rotation.x = lp(lUA.rotation.x, -0.28,       0.09);
        lUA.rotation.z = lp(lUA.rotation.z,  0.16,       0.09);
      }
      if (lLA) {
        lLA.rotation.x = lp(lLA.rotation.x, -0.18 + b2,  0.11);
      }
    } else {
      // return arms to rest
      if (rUA) { rUA.rotation.x = lp(rUA.rotation.x, 0, 0.07); rUA.rotation.z = lp(rUA.rotation.z, 0, 0.07); }
      if (rLA) { rLA.rotation.x = lp(rLA.rotation.x, 0, 0.07); }
      if (lUA) { lUA.rotation.x = lp(lUA.rotation.x, 0, 0.07); lUA.rotation.z = lp(lUA.rotation.z, 0, 0.07); }
      if (lLA) { lLA.rotation.x = lp(lLA.rotation.x, 0, 0.07); }
    }

    // ── VRM physics + lookAt tick ──────────────────────────────────────────
    vrm.update(delta);
  });

  return <group ref={groupRef} position={[0, -1.55, 0]} />;
}

// ─── Loading spinner ─────────────────────────────────────────────────────────
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

// ─── AvatarInterviewer (page component) ──────────────────────────────────────
type AudioMode = 'off' | 'mic' | 'synth' | 'angry' | 'happy';

export default function AvatarInterviewer() {
  const [audioMode,  setAudioMode]  = useState<AudioMode>('off');
  const [isNodding,  setIsNodding]  = useState(false);
  const [isShaking,  setIsShaking]  = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // shared Web Audio graph
  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // mic refs
  const streamRef   = useRef<MediaStream | null>(null);
  const micSrcRef   = useRef<MediaStreamAudioSourceNode | null>(null);

  // synth speech oscillators
  const synthNodesRef = useRef<AudioNode[]>([]);

  // ── ensure shared AudioContext + AnalyserNode ────────────────────────────
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

  // ── tear down any active source ──────────────────────────────────────────
  const stopAll = useCallback(() => {
    // stop mic
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    micSrcRef.current?.disconnect();
    micSrcRef.current = null;
    // stop synth oscillators
    for (const n of synthNodesRef.current) {
      try { (n as OscillatorNode).stop?.(); n.disconnect(); } catch { /* ignore */ }
    }
    synthNodesRef.current = [];
  }, []);

  // ── MIC ─────────────────────────────────────────────────────────────────
  const handleMic = useCallback(async () => {
    setAudioError(null);
    stopAll();
    try {
      const { ctx, analyser } = ensureCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src    = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      streamRef.current  = stream;
      micSrcRef.current  = src;
      setAudioMode('mic');
    } catch {
      setAudioError('Microphone access denied — allow permissions and try again.');
    }
  }, [ensureCtx, stopAll]);

  // ── SYNTHETIC SPEECH TEST ────────────────────────────────────────────────
  // Generates a speech-like oscillator mix so the lip-sync can be tested
  // completely offline without any external audio URL.
  const handleSynth = useCallback(() => {
    setAudioError(null);
    stopAll();
    const { ctx, analyser } = ensureCtx();

    const nodes: AudioNode[] = [];

    // Carrier: slightly detuned sawtooths to mimic a vocal tract
    const freqs = [145, 290, 580, 870, 1160];
    const gains  = [0.35, 0.25, 0.18, 0.10, 0.07];

    // Master gain with slow LFO → simulates syllable rhythm
    const master  = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(analyser);
    analyser.connect(ctx.destination);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3.2;          // ~3 syllables per second
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.45;
    lfo.connect(lfoGain);
    lfoGain.connect(master.gain);
    lfo.start();
    nodes.push(lfo, lfoGain);

    for (let i = 0; i < freqs.length; i++) {
      const osc  = ctx.createOscillator();
      osc.type   = 'sawtooth';
      osc.frequency.value = freqs[i] + (Math.random() - 0.5) * 4; // tiny detune
      const g    = ctx.createGain();
      g.gain.value = gains[i];
      osc.connect(g);
      g.connect(master);
      osc.start();
      nodes.push(osc, g);
    }

    nodes.push(master);
    synthNodesRef.current = nodes;
    setAudioMode('synth');
  }, [ensureCtx, stopAll]);

  // ── ANGRY TEST ─────────────────────────────────────────────────────────────
  // Loud, harsh square-wave oscillators → RMS well above SHOUT_RMS (0.10)
  // → triggers angry expression + head-tilt-back + jitter
  const handleAngryTest = useCallback(() => {
    setAudioError(null);
    stopAll();
    const { ctx, analyser } = ensureCtx();
    const nodes: AudioNode[] = [];

    const master = ctx.createGain();
    master.gain.value = 0.92;
    master.connect(analyser);
    analyser.connect(ctx.destination);

    // Fast LFO — agitated rhythm
    const lfo  = ctx.createOscillator();
    lfo.type   = 'sine';
    lfo.frequency.value = 5.5;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.20;  // small mod so it stays loud throughout
    lfo.connect(lfoG);
    lfoG.connect(master.gain);
    lfo.start();
    nodes.push(lfo, lfoG);

    // Discordant square waves (harsh timbre)
    const freqs = [110, 156, 233, 349];
    const gains = [0.40, 0.30, 0.22, 0.15];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type  = 'square';
      osc.frequency.value = freqs[i];
      const g   = ctx.createGain();
      g.gain.value = gains[i];
      osc.connect(g);
      g.connect(master);
      osc.start();
      nodes.push(osc, g);
    }

    nodes.push(master);
    synthNodesRef.current = nodes;
    setAudioMode('angry');
  }, [ensureCtx, stopAll]);

  // ── HAPPY TEST ──────────────────────────────────────────────────────────────
  // Bright triangle/sine waves at moderate gain → RMS ~0.04-0.07 (below SHOUT),
  // rich high-frequency content → drives high-band → happy expression
  const handleHappyTest = useCallback(() => {
    setAudioError(null);
    stopAll();
    const { ctx, analyser } = ensureCtx();
    const nodes: AudioNode[] = [];

    const master = ctx.createGain();
    master.gain.value = 0.16;  // moderate — above silence, below shout
    master.connect(analyser);
    analyser.connect(ctx.destination);

    // Gentle LFO — light, bouncy rhythm
    const lfo  = ctx.createOscillator();
    lfo.type   = 'sine';
    lfo.frequency.value = 2.2;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.06;
    lfo.connect(lfoG);
    lfoG.connect(master.gain);
    lfo.start();
    nodes.push(lfo, lfoG);

    // Bright harmonics (high-freq heavy → drives high-band)
    const freqs = [440, 880, 1320, 2200, 3300];
    const gains = [0.40, 0.30, 0.22, 0.15, 0.10];
    const types: OscillatorType[] = ['triangle', 'sine', 'triangle', 'sine', 'sine'];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type  = types[i];
      osc.frequency.value = freqs[i];
      const g   = ctx.createGain();
      g.gain.value = gains[i];
      osc.connect(g);
      g.connect(master);
      osc.start();
      nodes.push(osc, g);
    }

    nodes.push(master);
    synthNodesRef.current = nodes;
    setAudioMode('happy');
  }, [ensureCtx, stopAll]);

  // ── STOP ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    stopAll();
    setAudioMode('off');
  }, [stopAll]);

  // ── nod / shake ──────────────────────────────────────────────────────────
  const handleNod   = useCallback(() => { if (!isNodding)  setIsNodding(true);  }, [isNodding]);
  const handleShake = useCallback(() => { if (!isShaking)  setIsShaking(true);  }, [isShaking]);
  const onNodEnd    = useCallback(() => setIsNodding(false),  []);
  const onShakeEnd  = useCallback(() => setIsShaking(false), []);

  useEffect(() => () => { stopAll(); ctxRef.current?.close(); }, [stopAll]);

  const badge =
    audioMode === 'mic'   ? { label: '🎤 Mic Active',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' } :
    audioMode === 'synth' ? { label: '🔊 Synth Voice',   cls: 'text-violet-400  bg-violet-400/10  border-violet-400/40'  } :
    audioMode === 'angry' ? { label: '😡 Angry Voice',   cls: 'text-rose-400    bg-rose-400/10    border-rose-400/40'    } :
    audioMode === 'happy' ? { label: '😊 Happy Voice',   cls: 'text-yellow-400  bg-yellow-400/10  border-yellow-400/40'  } :
    null;

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

        {audioMode === 'off' && (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-500 pointer-events-none select-none">
            VRM Avatar · Drag to orbit · Scroll to zoom
          </p>
        )}
      </div>

      {/* controls */}
      <div className="shrink-0 border-t border-white/8 bg-white/[0.02] px-6 py-4 flex flex-col items-center gap-4">

        {audioError && <p className="text-rose-400 text-xs text-center">{audioError}</p>}

        {/* audio row — basic */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleMic}   active={audioMode==='mic'}   color="emerald">🎤 Start Mic Test</CtrlBtn>
          <CtrlBtn onClick={handleSynth} active={audioMode==='synth'} color="violet" >🔊 Normal Voice</CtrlBtn>
          <CtrlBtn onClick={handleStop}  active={false}               color="rose"   disabled={audioMode==='off'}>⏹ Stop Audio</CtrlBtn>
        </div>

        {/* audio row — emotion tests */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleAngryTest} active={audioMode==='angry'} color="rose" >😡 Test Angry Voice</CtrlBtn>
          <CtrlBtn onClick={handleHappyTest} active={audioMode==='happy'} color="amber">😊 Test Happy Voice</CtrlBtn>
        </div>

        <div className="w-full h-px bg-white/5" />

        {/* head animation row */}
        <div className="flex flex-wrap justify-center gap-2">
          <CtrlBtn onClick={handleNod}   active={isNodding}  color="sky"   disabled={isNodding} >👍 Nod Yes</CtrlBtn>
          <CtrlBtn onClick={handleShake} active={isShaking}  color="amber" disabled={isShaking} >👎 Shake No</CtrlBtn>
        </div>

        <p className="text-slate-600 text-[10px] text-center leading-relaxed">
          Speak loudly (&gt;80&nbsp;% vol) for angry&nbsp;reaction · A-E-I-O-U lip-sync active ·
          Arms move during speech · Head sway only during&nbsp;silence
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
      className={`px-5 py-2.5 rounded-xl font-semibold text-xs tracking-wide transition-all duration-200
        ${active   ? c.active
        : disabled ? 'opacity-40 cursor-not-allowed bg-white/5 text-slate-500 border border-white/10'
                   : `bg-gradient-to-r ${c.idle} text-white shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer`}`}>
      {children}
    </button>
  );
}
