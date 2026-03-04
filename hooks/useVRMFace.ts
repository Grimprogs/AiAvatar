import { useRef } from 'react';
import * as THREE from 'three';
import { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';
import type { TrackingData } from './useMediaPipeTracking';

export type EmotionMode = 'neutral' | 'angry' | 'happy' | 'sad';
export type BehaviorMode = 'neutral' | 'loudLaugh' | 'shyGiggle' | 'guilty' | 'angry' | 'blush';
type EK = 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'blink' | 'angry' | 'happy' | 'sad' | 'relaxed' | 'surprised' | 'cheekPuff';

const SILENCE_RMS = 0.015;
const SHOUT_RMS = 0.10;
const BAND_AMP = 2.4;
const lp = THREE.MathUtils.lerp;
const cl = THREE.MathUtils.clamp;

interface EmotionProfile {
  lipMult: number;
  viseme: { aa: number; ee: number; ih: number; oh: number; ou: number };
  secondary: Partial<Record<EK, number>>;
  alphaOverride?: Partial<Record<EK, number>>;
  headReactThreshold: number;
}

const EMOTION_PROFILES: Record<EmotionMode, EmotionProfile> = {
  neutral: { lipMult: 1.0, viseme: { aa: 1.0, ee: 0.80, ih: 0.80, oh: 1.00, ou: 1.00 }, secondary: { relaxed: 0.25 }, headReactThreshold: SHOUT_RMS },
  angry: { lipMult: 1.35, viseme: { aa: 1.20, ee: 1.50, ih: 1.60, oh: 0.60, ou: 0.40 }, secondary: { angry: 0.90, cheekPuff: 0.8 }, alphaOverride: { aa: 0.40, ee: 0.35, ih: 0.38 }, headReactThreshold: SHOUT_RMS * 0.6 },
  happy: { lipMult: 1.10, viseme: { aa: 1.30, ee: 1.40, ih: 0.80, oh: 0.80, ou: 0.60 }, secondary: { happy: 0.75, relaxed: 0.20 }, headReactThreshold: SHOUT_RMS * 1.5 },
  sad: { lipMult: 0.60, viseme: { aa: 0.60, ee: 0.40, ih: 0.40, oh: 1.20, ou: 1.40 }, secondary: { sad: 0.80, relaxed: 0.10 }, alphaOverride: { aa: 0.14, oh: 0.18, ou: 0.16 }, headReactThreshold: 9999 },
};

const BEHAVIOR_EXPRESSIONS: Record<BehaviorMode, Partial<Record<EK, number>>> = {
  neutral: {},
  loudLaugh: { happy: 1.0, aa: 1.0, blink: 0.80 },
  shyGiggle: { happy: 0.70, blink: 0.40, relaxed: 0.35 },
  guilty: { sad: 0.85, relaxed: 0.20, blink: 0.25 },
  angry: { angry: 1.0, surprised: 0.25 },
  blush: { happy: 0.40, relaxed: 0.90, blink: 0.30 },
};

function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += data[i];
  return Math.min(s / (hi - lo) / 255, 1);
}

export interface UseVRMFaceArgs {
  vrmRef: React.RefObject<VRM | null>;
  analyserRef?: React.RefObject<AnalyserNode | null>;
  trackingRef?: React.RefObject<TrackingData>;
  emotionMode: EmotionMode;
  behaviorMode: BehaviorMode;
  speechLevel?: number;
}

export function useVRMFace({
  vrmRef,
  analyserRef,
  trackingRef,
  emotionMode,
  behaviorMode,
  speechLevel
}: UseVRMFaceArgs) {
  const freqBuf = useRef<Uint8Array | null>(null);
  const timeBuf = useRef<Uint8Array | null>(null);
  const sRms = useRef(0);

  const curExpr = useRef<Record<EK, number>>({
    aa: 0, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0, angry: 0, happy: 0, sad: 0, relaxed: 0, surprised: 0, cheekPuff: 0
  });

  const nextBlink = useRef(0);
  const blinkT = useRef(-1);
  const isDoubleBlink = useRef(false);
  const asymmetryFactor = useRef(Math.random() * 0.1 - 0.05);

  // Dynamic emotional state for chill/expressive child-like behavior
  const currentMood = useRef<EK>('happy');
  const moodTimer = useRef(0);
  const moodIntensity = useRef(0);

  const tick = (now: number, delta: number) => {
    const vrm = vrmRef.current;
    if (!vrm) return { isSpeaking: false, headReact: false, curAa: 0 };

    const analyser = analyserRef?.current;
    const profile = EMOTION_PROFILES[emotionMode];
    const T = trackingRef?.current;
    const tracked = T?.active || false;

    const tgt: Record<EK, number> = {
      aa: 0, ee: 0, ih: 0, oh: 0, ou: 0, blink: 0, angry: 0, happy: 0, sad: 0, relaxed: 0, surprised: 0, cheekPuff: 0
    };

    for (const [k, v] of Object.entries(profile.secondary)) tgt[k as EK] = v as number;

    let isSpeaking = false;
    let headReact = false;

    if (analyser) {
      if (!freqBuf.current) freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuf.current) timeBuf.current = new Uint8Array(analyser.fftSize);

      analyser.getByteTimeDomainData(timeBuf.current as any);
      let sq = 0;
      for (let i = 0; i < timeBuf.current.length; i++) {
        const s = (timeBuf.current[i] - 128) / 128;
        sq += s * s;
      }
      const rms = Math.sqrt(sq / timeBuf.current.length);
      sRms.current = lp(sRms.current, rms, 0.28);

      isSpeaking = sRms.current > SILENCE_RMS;
      headReact = sRms.current > profile.headReactThreshold;

      if (isSpeaking) {
        analyser.getByteFrequencyData(freqBuf.current as any);
        const N = freqBuf.current.length;
        const t = Math.floor(N / 3);
        const rL = bandAvg(freqBuf.current, 0, t);
        const rM = bandAvg(freqBuf.current, t, t * 2);
        const rH = bandAvg(freqBuf.current, t * 2, N);
        const vol = Math.pow(cl(sRms.current / 0.12, 0, 1), 0.70);
        const low = cl(rL * BAND_AMP, 0, 1);
        const mid = cl(rM * BAND_AMP, 0, 1);
        const high = cl(rH * BAND_AMP, 0, 1);
        const pv = profile.viseme;
        const lm = profile.lipMult;

        tgt.aa = cl(mid * vol * 1.40 * pv.aa * lm, 0, 1);
        tgt.ee = cl(mid * vol * 0.75 * pv.ee * lm, 0, 1);
        tgt.ih = cl(high * vol * 1.10 * pv.ih * lm, 0, 1);
        tgt.oh = cl(low * vol * 1.10 * pv.oh * lm, 0, 1);
        tgt.ou = cl(low * Math.max(0, 0.45 - tgt.aa) * vol * 1.60 * pv.ou * lm, 0, 1);

        for (const [k, v] of Object.entries(profile.secondary)) tgt[k as EK] = cl((v as number) * (0.6 + vol * 0.4), 0, 1);
        if (emotionMode === 'happy') tgt.happy = cl(high * vol * 1.10 + 0.6, 0, 1);
        if (headReact && emotionMode === 'angry') { tgt.angry = 1.0; tgt.aa = cl(tgt.aa * 1.25, 0, 1); }
      }
    } else if (speechLevel !== undefined) {
      // Fallback to speechLevel provided by props
      isSpeaking = speechLevel > 0.05;
      headReact = speechLevel > profile.headReactThreshold;

      if (isSpeaking) {
        const vol = cl(speechLevel * 2.35, 0, 1);
        const pv = profile.viseme;
        const lm = profile.lipMult;

        tgt.aa = cl(vol * 1.40 * pv.aa * lm, 0, 1);
        tgt.ee = cl(vol * 0.75 * pv.ee * lm, 0, 1);
        tgt.ih = cl(vol * 1.10 * pv.ih * lm, 0, 1);
        tgt.oh = cl(vol * 1.10 * pv.oh * lm, 0, 1);
        tgt.ou = cl(vol * 1.60 * pv.ou * lm, 0, 1);

        for (const [k, v] of Object.entries(profile.secondary)) tgt[k as EK] = cl((v as number) * (0.6 + vol * 0.4), 0, 1);
        if (emotionMode === 'happy') tgt.happy = cl(vol * 1.10 + 0.6, 0, 1);
        if (headReact && emotionMode === 'angry') { tgt.angry = 1.0; tgt.aa = cl(tgt.aa * 1.25, 0, 1); }

        // Give the AI independent, organic, and EXTREMELY expressive child-like animations
        moodTimer.current -= delta;
        if (moodTimer.current <= 0) {
          const moods: EK[] = ['happy', 'happy', 'surprised', 'angry', 'sad', 'relaxed'];
          currentMood.current = moods[Math.floor(Math.random() * moods.length)];
          moodTimer.current = 1.5 + Math.random() * 3.0;
        }

        // Ramp up the intensity of the current mood when speaking loudly
        moodIntensity.current = lp(moodIntensity.current, vol * 1.5, 0.1);
        const m = currentMood.current;
        if (m === 'happy') { tgt.happy = cl(tgt.happy + moodIntensity.current, 0, 1); tgt.surprised = cl(tgt.surprised + moodIntensity.current * 0.3, 0, 1); }
        if (m === 'surprised') { tgt.surprised = cl(tgt.surprised + moodIntensity.current * 1.2, 0, 1); tgt.oh = cl(Math.max(tgt.oh, moodIntensity.current * 0.8), 0, 1); }
        if (m === 'angry') { tgt.angry = cl(tgt.angry + moodIntensity.current, 0, 1); tgt.ee = cl(Math.max(tgt.ee, moodIntensity.current * 0.6), 0, 1); }
        if (m === 'sad') { tgt.sad = cl(tgt.sad + moodIntensity.current, 0, 1); tgt.ou = cl(Math.max(tgt.ou, moodIntensity.current * 0.5), 0, 1); }
        if (m === 'relaxed') tgt.relaxed = cl(tgt.relaxed + moodIntensity.current, 0, 1);
      } else {
        moodIntensity.current = lp(moodIntensity.current, 0, 0.05);
      }
    }

    // Removed direct face tracking mirroring so the AI expresses itself independently instead of copying the user.

    if (behaviorMode !== 'neutral') {
      const bExp = BEHAVIOR_EXPRESSIONS[behaviorMode];
      for (const [k, v] of Object.entries(bExp)) tgt[k as EK] = cl(Math.max(tgt[k as EK] ?? 0, v as number), 0, 1);
    } else {
      // Humanized Blinking (with chance of double blink)
      if (nextBlink.current === 0) nextBlink.current = now + 2 + Math.random() * 3;
      if (blinkT.current < 0 && now >= nextBlink.current) {
        blinkT.current = now;
        isDoubleBlink.current = Math.random() > 0.75; // 25% chance of double blink
        nextBlink.current = now + 3.0 + Math.random() * 4.0;
        asymmetryFactor.current = Math.random() * 0.1 - 0.05; // New asymmetry each blink
      }

      if (blinkT.current >= 0) {
        const HALF = 0.06;
        let el = now - blinkT.current;

        // Handle double blink timing
        if (isDoubleBlink.current && el > HALF * 2.5 && el < HALF * 5.0) {
          el -= HALF * 2.5; // Restart animation for second blink
        }

        tgt.blink = el < HALF ? el / HALF : Math.max(0, 1 - (el - HALF) / HALF);
        if (tgt.blink < 0) tgt.blink = 0;

        if (el >= HALF * (isDoubleBlink.current ? 5.0 : 2.0)) blinkT.current = -1;
      }
    }

    const ALPHA: Record<EK, number> = {
      aa: 0.28, ee: 0.20, ih: 0.20, oh: 0.24, ou: 0.18, blink: 0.90, angry: 0.18, happy: 0.14, sad: 0.12, relaxed: 0.10, surprised: 0.15, cheekPuff: 0.1
    };
    if (profile.alphaOverride) for (const [k, v] of Object.entries(profile.alphaOverride)) ALPHA[k as EK] = v as number;

    for (const k of Object.keys(tgt) as EK[]) {
      curExpr.current[k] = lp(curExpr.current[k], tgt[k], ALPHA[k]);
      vrm.expressionManager?.setValue(k as VRMExpressionPresetName, curExpr.current[k]);
    }

    // Apply slight asymmetry
    if (vrm.expressionManager) {
      if (curExpr.current.happy > 0.1 || curExpr.current.sad > 0.1) {
        vrm.expressionManager.setValue('blinkLeft' as VRMExpressionPresetName, cl(curExpr.current.blink + asymmetryFactor.current, 0, 1));
        vrm.expressionManager.setValue('blinkRight' as VRMExpressionPresetName, cl(curExpr.current.blink - asymmetryFactor.current, 0, 1));
      }
      vrm.expressionManager.update();
    }

    return { isSpeaking, headReact, curAa: curExpr.current.aa };
  };

  return { tick, curExpr };
}