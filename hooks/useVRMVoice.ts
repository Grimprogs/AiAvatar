/**
 * useVRMVoice.ts
 *
 * Encapsulates all Web Audio API concerns:
 *   • AudioContext / AnalyserNode lifecycle (ensureCtx)
 *   • Microphone capture (handleMic)
 *   • Oscillator synth presets (handleSynth / Angry / Happy / Sad)
 *   • Text-to-Speech via StreamElements (handleTTS)
 *   • Unified stopAll teardown
 *
 * The hook owns audioMode, audioError, inputText, isSpeakingText state
 * so the parent component only needs to read them, not manage them.
 *
 * Usage:
 *   const voice = useVRMVoice({ onEmotionSuggested: setEmotionMode });
 *   // pass voice.analyserRef into <VRMAvatarMesh>
 *   // render voice.audioError / voice.inputText / voice.isSpeakingText in UI
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import type { EmotionMode } from './useVRMFace';

// ─── types ────────────────────────────────────────────────────────────────────
export type AudioMode = 'off' | 'mic' | 'synth' | 'angry' | 'happy' | 'sad';

interface UseVRMVoiceOptions {
  /** Called when a synth preset has an associated emotion (e.g. angry test → 'angry'). */
  onEmotionSuggested?: (emotion: EmotionMode) => void;
}

export interface UseVRMVoiceReturn {
  // Refs consumed by the Three.js frame loop
  analyserRef: React.RefObject<AnalyserNode | null>;

  // Reactive state for the UI
  audioMode:        AudioMode;
  audioError:       string | null;
  inputText:        string;
  setInputText:     (v: string) => void;
  isSpeakingText:   boolean;

  // Audio control handlers
  handleMic:        () => Promise<void>;
  handleStop:       () => void;
  handleSynth:      () => void;
  handleAngryTest:  () => void;
  handleHappyTest:  () => void;
  handleSadTest:    () => void;
  handleTTS:        () => void;
}

// ─── buildSynth helper ────────────────────────────────────────────────────────
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

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = lfoFreq;
  const lg = ctx.createGain();
  lg.gain.value = lfoGain;
  lfo.connect(lg);
  lg.connect(master.gain);
  lfo.start();
  nodes.push(lfo, lg);

  for (let i = 0; i < freqs.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = types[i] ?? 'sawtooth';
    osc.frequency.value = freqs[i] + (Math.random() - 0.5) * 3;
    const g = ctx.createGain();
    g.gain.value = gains[i];
    osc.connect(g);
    g.connect(master);
    osc.start();
    nodes.push(osc, g);
  }

  return nodes;
}

// ─── hook ─────────────────────────────────────────────────────────────────────
export function useVRMVoice({ onEmotionSuggested }: UseVRMVoiceOptions = {}): UseVRMVoiceReturn {
  const [audioMode,      setAudioMode]      = useState<AudioMode>('off');
  const [audioError,     setAudioError]     = useState<string | null>(null);
  const [inputText,      setInputText]      = useState('Hello! I am your AI interviewer.');
  const [isSpeakingText, setIsSpeakingText] = useState(false);

  const ctxRef        = useRef<AudioContext | null>(null);
  const analyserRef   = useRef<AnalyserNode | null>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const micSrcRef     = useRef<MediaStreamAudioSourceNode | null>(null);
  const synthNodesRef = useRef<AudioNode[]>([]);
  const ttsAudioRef   = useRef<HTMLAudioElement | null>(null);

  // ── ensureCtx ─────────────────────────────────────────────────────────────
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

  // ── stopAll ───────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    micSrcRef.current?.disconnect();
    micSrcRef.current = null;
    for (const n of synthNodesRef.current) {
      try { (n as OscillatorNode).stop?.(); n.disconnect(); } catch { /* ok */ }
    }
    synthNodesRef.current = [];
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
  }, []);

  // ── microphone ────────────────────────────────────────────────────────────
  const handleMic = useCallback(async () => {
    setAudioError(null);
    stopAll();
    try {
      const { ctx, analyser } = ensureCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src    = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      streamRef.current = stream;
      micSrcRef.current = src;
      setAudioMode('mic');
    } catch {
      setAudioError('Microphone access denied.');
    }
  }, [ensureCtx, stopAll]);

  // ── synth presets ─────────────────────────────────────────────────────────
  const handleSynth = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(
      ctx, analyser,
      [145, 290, 580, 870, 1160], [0.35, 0.25, 0.18, 0.10, 0.07],
      ['sawtooth','sawtooth','sawtooth','sawtooth','sawtooth'],
      0.50, 3.2, 0.45,
    );
    setAudioMode('synth');
    onEmotionSuggested?.('neutral');
  }, [ensureCtx, stopAll, onEmotionSuggested]);

  const handleAngryTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(
      ctx, analyser,
      [110, 156, 233, 349], [0.40, 0.30, 0.22, 0.15],
      ['square','square','square','square'],
      0.92, 5.5, 0.20,
    );
    setAudioMode('angry');
    onEmotionSuggested?.('angry');
  }, [ensureCtx, stopAll, onEmotionSuggested]);

  const handleHappyTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(
      ctx, analyser,
      [440, 880, 1320, 2200, 3300], [0.40, 0.30, 0.22, 0.15, 0.10],
      ['triangle','sine','triangle','sine','sine'],
      0.16, 2.2, 0.06,
    );
    setAudioMode('happy');
    onEmotionSuggested?.('happy');
  }, [ensureCtx, stopAll, onEmotionSuggested]);

  const handleSadTest = useCallback(() => {
    setAudioError(null); stopAll();
    const { ctx, analyser } = ensureCtx();
    synthNodesRef.current = buildSynth(
      ctx, analyser,
      [80, 160, 240, 320], [0.28, 0.20, 0.14, 0.08],
      ['sine','sine','triangle','sine'],
      0.13, 1.2, 0.04,
    );
    setAudioMode('sad');
    onEmotionSuggested?.('sad');
  }, [ensureCtx, stopAll, onEmotionSuggested]);

  // ── Text-to-Speech ────────────────────────────────────────────────────────
  const handleTTS = useCallback(() => {
    if (!inputText.trim()) return;
    setAudioError(null);
    stopAll();

    const { ctx, analyser } = ensureCtx();

    // StreamElements TTS — free, no CORS issues
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(inputText)}`;
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    ttsAudioRef.current = audio;

    audio.onplay = () => {
      const src = ctx.createMediaElementSource(audio);
      src.connect(analyser);
      analyser.connect(ctx.destination);
      synthNodesRef.current.push(src as unknown as AudioNode);
      setAudioMode('synth');
      setIsSpeakingText(true);
    };

    audio.onended = () => {
      setIsSpeakingText(false);
      setAudioMode('off');
      stopAll();
    };

    audio.onerror = () => {
      setAudioError('TTS failed to load. Check internet connection.');
      setIsSpeakingText(false);
    };

    audio.play().catch(() => setAudioError('Click the screen first to allow audio.'));
  }, [inputText, ensureCtx, stopAll]);

  // ── stop ──────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    stopAll();
    setAudioMode('off');
  }, [stopAll]);

  // ── cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAll();
      ctxRef.current?.close();
    };
  }, [stopAll]);

  return {
    analyserRef,
    audioMode,
    audioError,
    inputText,
    setInputText,
    isSpeakingText,
    handleMic,
    handleStop,
    handleSynth,
    handleAngryTest,
    handleHappyTest,
    handleSadTest,
    handleTTS,
  };
}
