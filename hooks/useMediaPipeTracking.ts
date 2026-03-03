/**
 * useMediaPipeTracking.ts
 *
 * Runs MediaPipe FaceLandmarker + GestureRecognizer in a separate rAF loop
 * — completely decoupled from the Three.js render loop so FPS never suffers.
 *
 * Architecture:
 *   rAF tick ──writes──► trackingDataRef ──reads──► Three.js useFrame
 *
 * All results go into a plain ref (no React state) so reading them from
 * useFrame causes zero re-renders.
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import {
  FaceLandmarker,
  GestureRecognizer,
  FilesetResolver,
  type FaceLandmarkerResult,
  type GestureRecognizerResult,
} from '@mediapipe/tasks-vision';
import * as THREE from 'three';

// ─── public data contract ─────────────────────────────────────────────────────
export interface TrackingData {
  active: boolean;

  // ── Head pose (radians, VRM-normalized space) ────────────────────────────
  headPitch: number;   // nod   +forward / -backward
  headYaw:   number;   // turn  +right   / -left   (mirrored for avatar)
  headRoll:  number;   // tilt  +right   / -left

  // ── Blendshapes (0-1) ────────────────────────────────────────────────────
  eyeBlinkLeft:  number;
  eyeBlinkRight: number;
  mouthSmile:    number;   // avg mouthSmileLeft + mouthSmileRight
  jawOpen:       number;
  mouthFunnel:   number;   // drives "ou"
  mouthPucker:   number;   // drives "oh"
  browInnerUp:   number;   // drives "sad"
  cheekPuff:     number;   // drives "happy" boost

  // ── Gesture / interaction ────────────────────────────────────────────────
  handToMouth:  boolean;  // user's hand is near their own mouth
  isGiggling:   boolean;  // handToMouth + happy expression simultaneously

  // ── Motion / idle detection ──────────────────────────────────────────────
  motionEnergy: number;   // rolling RMS of landmark delta (0 = perfectly still)
  isBored:      boolean;  // true after BORED_DELAY_S of low motion
}

export const DEFAULT_TRACKING: TrackingData = {
  active: false,
  headPitch: 0, headYaw: 0, headRoll: 0,
  eyeBlinkLeft: 0, eyeBlinkRight: 0,
  mouthSmile: 0, jawOpen: 0, mouthFunnel: 0, mouthPucker: 0,
  browInnerUp: 0, cheekPuff: 0,
  handToMouth: false, isGiggling: false,
  motionEnergy: 0, isBored: false,
};

// ─── constants ────────────────────────────────────────────────────────────────
// @mediapipe/tasks-vision WASM assets — served locally from public/mediapipe/wasm
// (copied from node_modules at build time to avoid CDN MIME-type issues)
const WASM_CDN   = '/mediapipe/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const GEST_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

// Motion-energy threshold below which the user is "not moving"
const BORED_THRESHOLD = 0.00025;
// Seconds of stillness before "bored" state is entered
const BORED_DELAY_S   = 5.0;
// Hand-to-mouth normalised-coord distance threshold
const H2M_DIST        = 0.14;

// ─── helpers ──────────────────────────────────────────────────────────────────
function lp(a: number, b: number, t: number) { return a + (b - a) * t; }
const cl = THREE.MathUtils.clamp;

/** Pull a single blendshape score by ARKit category name */
function bsScore(result: FaceLandmarkerResult, name: string): number {
  if (!result.faceBlendshapes?.length) return 0;
  const cat = result.faceBlendshapes[0].categories.find(c => c.categoryName === name);
  return cat?.score ?? 0;
}

// ─── hook ─────────────────────────────────────────────────────────────────────
export type TrackingStatus = 'idle' | 'loading' | 'ready' | 'active' | 'error';

export function useMediaPipeTracking() {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const trackingRef = useRef<TrackingData>({ ...DEFAULT_TRACKING });

  const [status,    setStatus]    = useState<TrackingStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');

  // ── internal refs ──────────────────────────────────────────────────────────
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const gestureRecRef     = useRef<GestureRecognizer | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const rafRef            = useRef(0);
  const prevLandmarks     = useRef<Array<{ x: number; y: number }> | null>(null);
  const boredTimer        = useRef(0);
  const lastFrameMs       = useRef(0);

  // ── load models (call once; idempotent) ───────────────────────────────────
  const loadModels = useCallback(async () => {
    if (faceLandmarkerRef.current) return;   // already loaded
    setStatus('loading');
    setStatusMsg('Downloading MediaPipe models…');
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

      const [fl, gr] = await Promise.all([
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: FACE_MODEL,
            delegate: 'GPU',
          },
          outputFaceBlendshapes:              true,
          outputFacialTransformationMatrixes: true,
          runningMode: 'VIDEO',
          numFaces:    1,
        }),
        GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: GEST_MODEL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands:    1,
        }),
      ]);

      faceLandmarkerRef.current = fl;
      gestureRecRef.current     = gr;
      setStatus('ready');
      setStatusMsg('Models ready');
    } catch (e) {
      console.error('[MediaPipe] model load error:', e);
      setStatus('error');
      setStatusMsg('Model load failed — check network/WebGL');
    }
  }, []);

  // ── start tracking ─────────────────────────────────────────────────────────
  const startTracking = useCallback(async () => {
    if (!faceLandmarkerRef.current) await loadModels();
    if (!faceLandmarkerRef.current) return;   // load failed

    setStatusMsg('Requesting camera…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      trackingRef.current.active = true;
      setStatus('active');
      setStatusMsg('Tracking active');
    } catch (e) {
      console.error('[MediaPipe] camera error:', e);
      setStatus('error');
      setStatusMsg('Camera access denied');
    }
  }, [loadModels]);

  // ── stop tracking ──────────────────────────────────────────────────────────
  const stopTracking = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    prevLandmarks.current = null;
    boredTimer.current    = 0;
    Object.assign(trackingRef.current, DEFAULT_TRACKING);
    setStatus(faceLandmarkerRef.current ? 'ready' : 'idle');
    setStatusMsg('Tracking stopped');
  }, []);

  // ── rAF tick ───────────────────────────────────────────────────────────────
  // Runs in its own requestAnimationFrame, separate from Three.js render.
  useEffect(() => {
    const fl    = faceLandmarkerRef.current;
    const gr    = gestureRecRef.current;
    const video = videoRef.current;

    if (status !== 'active' || !fl || !gr || !video) return;

    const tick = (nowMs: DOMHighResTimeStamp) => {
      rafRef.current = requestAnimationFrame(tick);

      // Skip duplicate timestamps (browser throttle / tab hidden)
      if (video.readyState < 2 || nowMs === lastFrameMs.current) return;
      const dt = Math.min((nowMs - lastFrameMs.current) / 1000, 0.1);
      lastFrameMs.current = nowMs;

      const T = trackingRef.current;

      // ── FaceLandmarker ───────────────────────────────────────────────────
      let faceResult: FaceLandmarkerResult | null = null;
      try { faceResult = fl.detectForVideo(video, nowMs); } catch { /* skip frame */ }

      if (faceResult?.faceLandmarks?.length) {
        const lms = faceResult.faceLandmarks[0];

        // ── Head pose from 4×4 facial transformation matrix ─────────────
        const mats = faceResult.facialTransformationMatrixes;
        if (mats?.length) {
          const m = mats[0].data;
          // Column-major Float32Array → THREE Matrix4 (row-major)
          const mat4 = new THREE.Matrix4().set(
            m[0], m[4], m[8],  m[12],
            m[1], m[5], m[9],  m[13],
            m[2], m[6], m[10], m[14],
            m[3], m[7], m[11], m[15],
          );
          const euler = new THREE.Euler().setFromRotationMatrix(mat4, 'YXZ');
          // Mirror yaw so avatar mirrors the user's movement
          T.headPitch = lp(T.headPitch, cl(euler.x,   -0.50,  0.50), 0.25);
          T.headYaw   = lp(T.headYaw,   cl(-euler.y,  -0.60,  0.60), 0.25);
          T.headRoll  = lp(T.headRoll,  cl(-euler.z,  -0.35,  0.35), 0.25);
        }

        // ── Blendshapes ──────────────────────────────────────────────────
        if (faceResult.faceBlendshapes?.length) {
          T.eyeBlinkLeft  = lp(T.eyeBlinkLeft,  bsScore(faceResult, 'eyeBlinkLeft'),  0.35);
          T.eyeBlinkRight = lp(T.eyeBlinkRight, bsScore(faceResult, 'eyeBlinkRight'), 0.35);
          T.jawOpen       = lp(T.jawOpen,       bsScore(faceResult, 'jawOpen'),        0.25);
          T.mouthSmile    = lp(T.mouthSmile,
            (bsScore(faceResult, 'mouthSmileLeft') + bsScore(faceResult, 'mouthSmileRight')) * 0.5,
            0.20,
          );
          T.mouthFunnel   = lp(T.mouthFunnel,  bsScore(faceResult, 'mouthFunnel'),   0.22);
          T.mouthPucker   = lp(T.mouthPucker,  bsScore(faceResult, 'mouthPucker'),   0.22);
          T.browInnerUp   = lp(T.browInnerUp,  bsScore(faceResult, 'browInnerUp'),   0.20);
          T.cheekPuff     = lp(T.cheekPuff,    bsScore(faceResult, 'cheekPuff'),     0.18);
        }

        // ── Motion energy → bored detection ──────────────────────────────
        let energy = 0;
        if (prevLandmarks.current) {
          const prev = prevLandmarks.current;
          const n    = Math.min(lms.length, prev.length);
          for (let i = 0; i < n; i++) {
            const dx = lms[i].x - prev[i].x;
            const dy = lms[i].y - prev[i].y;
            energy  += dx * dx + dy * dy;
          }
          energy = Math.sqrt(energy / n);
        }
        prevLandmarks.current = lms.map(l => ({ x: l.x, y: l.y }));
        T.motionEnergy = lp(T.motionEnergy, energy, 0.15);

        if (T.motionEnergy < BORED_THRESHOLD) {
          boredTimer.current += dt;
        } else {
          boredTimer.current = Math.max(0, boredTimer.current - dt * 2.5);
        }
        T.isBored = boredTimer.current > BORED_DELAY_S;

        // ── GestureRecognizer + hand-to-mouth calc ────────────────────────
        // Face landmark 13 = upper lip center
        const mouthLm = lms[13];

        let gestResult: GestureRecognizerResult | null = null;
        try { gestResult = gr.recognizeForVideo(video, nowMs); } catch { /* skip */ }

        let handToMouth = false;
        if (gestResult?.landmarks?.length) {
          // Use index fingertip (landmark 8) as the hand reference point
          const tip  = gestResult.landmarks[0][8];
          const dist = Math.hypot(tip.x - mouthLm.x, tip.y - mouthLm.y);
          handToMouth = dist < H2M_DIST;
        }

        T.handToMouth = handToMouth;
        T.isGiggling  = handToMouth && T.mouthSmile > 0.45;

      } else {
        // No face in frame — decay all values back toward resting
        T.headPitch    = lp(T.headPitch,    0, 0.06);
        T.headYaw      = lp(T.headYaw,      0, 0.06);
        T.headRoll     = lp(T.headRoll,     0, 0.06);
        T.motionEnergy = lp(T.motionEnergy, 0, 0.06);
        boredTimer.current = Math.max(0, boredTimer.current - dt);
        T.isBored      = boredTimer.current > BORED_DELAY_S;
        T.handToMouth  = false;
        T.isGiggling   = false;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status]);

  // ── cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    /** Hidden <video> element to mount in JSX — do not render visibly */
    videoRef,
    /** Live tracking data — read from Three.js useFrame, never causes re-renders */
    trackingRef,
    status,
    statusMsg,
    loadModels,
    startTracking,
    stopTracking,
  };
}
