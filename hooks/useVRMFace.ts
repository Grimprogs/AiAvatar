import { useRef } from 'react';
import * as THREE from 'three';
import { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';
import type { TrackingData } from './useMediaPipeTracking';

export type EmotionMode  = 'neutral' | 'angry' | 'happy' | 'sad';
export type BehaviorMode = 'neutral' | 'loudLaugh' | 'shyGiggle' | 'guilty' | 'angry' | 'blush';
type EK = 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'blink' | 'angry' | 'happy' | 'sad' | 'relaxed' | 'surprised';

const SILENCE_RMS   = 0.015;
const SHOUT_RMS     = 0.10;
const BAND_AMP      = 2.4;
const lp = THREE.MathUtils.lerp;
const cl = THREE.MathUtils.clamp;

interface EmotionProfile {
  lipMult:   number;
  viseme:    { aa: number; ee: number; ih: number; oh: number; ou: number };
  secondary: Partial<Record<EK, number>>;
  alphaOverride?: Partial<Record<EK, number>>;
  headReactThreshold: number;
}

const EMOTION_PROFILES: Record<EmotionMode, EmotionProfile> = {
  neutral: { lipMult: 1.0, viseme: { aa:1.0, ee:0.80, ih:0.80, oh:1.00, ou:1.00 }, secondary: { relaxed: 0.25 }, headReactThreshold: SHOUT_RMS },
  angry:   { lipMult: 1.35, viseme: { aa:1.20, ee:1.50, ih:1.60, oh:0.60, ou:0.40 }, secondary: { angry: 0.90 }, alphaOverride: { aa:0.40, ee:0.35, ih:0.38 }, headReactThreshold: SHOUT_RMS * 0.6 },
  happy:   { lipMult: 1.10, viseme: { aa:1.30, ee:1.40, ih:0.80, oh:0.80, ou:0.60 }, secondary: { happy: 0.75, relaxed: 0.20 }, headReactThreshold: SHOUT_RMS * 1.5 },
  sad:     { lipMult: 0.60, viseme: { aa:0.60, ee:0.40, ih:0.40, oh:1.20, ou:1.40 }, secondary: { sad: 0.80, relaxed: 0.10 }, alphaOverride: { aa:0.14, oh:0.18, ou:0.16 }, headReactThreshold: 9999 },
};

const BEHAVIOR_EXPRESSIONS: Record<BehaviorMode, Partial<Record<EK, number>>> = {
  neutral:   {},   
  loudLaugh: { happy: 1.0, aa: 1.0, blink: 0.80 },
  shyGiggle: { happy: 0.70, blink: 0.40, relaxed: 0.35 },
  guilty:    { sad: 0.85, relaxed: 0.20, blink: 0.25 },
  angry:     { angry: 1.0, surprised: 0.25 },
  blush:     { happy: 0.40, relaxed: 0.90, blink: 0.30 },
};

function bandAvg(data: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i < hi; i++) s += data[i];
  return Math.min(s / (hi - lo) / 255, 1);
}

export function useVRMFace() {
  const freqBuf = useRef<Uint8Array | null>(null);
  const timeBuf = useRef<Uint8Array | null>(null);
  const sRms    = useRef(0);

  const curExpr = useRef<Record<EK, number>>({
    aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0, surprised:0,
  });

  const nextBlink = useRef(0);
  const blinkT    = useRef(-1);

  const tickFace = (vrm: VRM | null, analyser: AnalyserNode | null, trackingRef: React.RefObject<TrackingData>, emotionMode: EmotionMode, behaviorMode: BehaviorMode, now: number, delta: number) => {
    if (!vrm) return { isSpeaking: false, headReact: false };

    const profile = EMOTION_PROFILES[emotionMode];
    const T       = trackingRef.current;
    const tracked = T?.active || false;

    const tgt: Record<EK, number> = {
      aa:0, ee:0, ih:0, oh:0, ou:0, blink:0, angry:0, happy:0, sad:0, relaxed:0, surprised:0,
    };

    for (const [k, v] of Object.entries(profile.secondary)) tgt[k as EK] = v as number;

    let isSpeaking = false;
    let headReact  = false;

    if (analyser) {
      if (!freqBuf.current) freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuf.current) timeBuf.current  = new Uint8Array(analyser.fftSize);

      analyser.getByteTimeDomainData(timeBuf.current);
      let sq = 0;
      for (let i = 0; i < timeBuf.current.length; i++) {
        const s = (timeBuf.current[i] - 128) / 128;
        sq += s * s;
      }
      const rms = Math.sqrt(sq / timeBuf.current.length);
      sRms.current = lp(sRms.current, rms, 0.28);

      isSpeaking = sRms.current > SILENCE_RMS;
      headReact  = sRms.current > profile.headReactThreshold;

      if (isSpeaking) {
        analyser.getByteFrequencyData(freqBuf.current);
        const N = freqBuf.current.length;
        const t = Math.floor(N / 3);
        const rL = bandAvg(freqBuf.current, 0, t);
        const rM = bandAvg(freqBuf.current, t, t * 2);
        const rH = bandAvg(freqBuf.current, t * 2, N);
        const vol  = Math.pow(cl(sRms.current / 0.12, 0, 1), 0.70);
        const low  = cl(rL * BAND_AMP, 0, 1);
        const mid  = cl(rM * BAND_AMP, 0, 1);
        const high = cl(rH * BAND_AMP, 0, 1);
        const pv   = profile.viseme;
        const lm   = profile.lipMult;

        tgt.aa = cl(mid  * vol * 1.40 * pv.aa * lm, 0, 1);
        tgt.ee = cl(mid  * vol * 0.75 * pv.ee * lm, 0, 1);
        tgt.ih = cl(high * vol * 1.10 * pv.ih * lm, 0, 1);
        tgt.oh = cl(low  * vol * 1.10 * pv.oh * lm, 0, 1);
        tgt.ou = cl(low  * Math.max(0, 0.45 - tgt.aa) * vol * 1.60 * pv.ou * lm, 0, 1);

        for (const [k, v] of Object.entries(profile.secondary)) tgt[k as EK] = cl((v as number) * (0.6 + vol * 0.4), 0, 1);
        if (emotionMode === 'happy') tgt.happy = cl(high * vol * 1.10 + 0.6, 0, 1);
        if (headReact && emotionMode === 'angry') { tgt.angry = 1.0; tgt.aa = cl(tgt.aa * 1.25, 0, 1); }
      }
    }

    if (tracked) {
      tgt.blink = cl(Math.max(T!.eyeBlinkLeft, T!.eyeBlinkRight), 0, 1);
      tgt.aa = cl(Math.max(tgt.aa, T!.jawOpen      * 0.90), 0, 1);
      tgt.oh = cl(Math.max(tgt.oh, T!.mouthPucker  * 0.85), 0, 1);
      tgt.ou = cl(Math.max(tgt.ou, T!.mouthFunnel  * 0.85), 0, 1);
      tgt.happy  = cl(Math.max(tgt.happy, T!.mouthSmile * 1.20), 0, 1);
      tgt.sad    = cl(Math.max(tgt.sad,   T!.browInnerUp * 0.60), 0, 1);
      if (T!.isBored) tgt.relaxed = cl(tgt.relaxed + 0.30, 0, 1);
      if (T!.isGiggling) tgt.happy = 1.0;
    }

    if (behaviorMode !== 'neutral') {
      const bExp = BEHAVIOR_EXPRESSIONS[behaviorMode];
      for (const [k, v] of Object.entries(bExp)) tgt[k as EK] = cl(Math.max(tgt[k as EK] ?? 0, v as number), 0, 1);
    } else {
      if (nextBlink.current === 0) nextBlink.current = now + 2 + Math.random() * 2;
      if (blinkT.current < 0 && now >= nextBlink.current) { blinkT.current = now; nextBlink.current = now + 3.0 + Math.random() * 2.0; }
      if (blinkT.current >= 0) { const HALF = 0.07; const el = now - blinkT.current; tgt.blink = el < HALF ? el / HALF : Math.max(0, 1 - (el - HALF) / HALF); if (el >= HALF * 2) blinkT.current = -1; }
    }

    const ALPHA: Record<EK, number> = {
      aa:0.28, ee:0.20, ih:0.20, oh:0.24, ou:0.18, blink:0.90, angry:0.18, happy:0.14, sad:0.12, relaxed:0.10, surprised:0.15,
    };
    if (profile.alphaOverride) for (const [k, v] of Object.entries(profile.alphaOverride)) ALPHA[k as EK] = v as number;
    if (tracked) { ALPHA.blink = 0.92; ALPHA.aa = 0.38; ALPHA.happy = 0.25; }

    for (const k of Object.keys(tgt) as EK[]) {
      curExpr.current[k] = lp(curExpr.current[k], tgt[k], ALPHA[k]);
      vrm.expressionManager?.setValue(k as VRMExpressionPresetName, curExpr.current[k]);
    }
    vrm.expressionManager?.update();

    return { isSpeaking, headReact, curAa: curExpr.current.aa };
  };

  return { tickFace };
}