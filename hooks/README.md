# hooks/

This directory contains reusable React hooks that encapsulate side effects, audio, tracking, and VRM logic.

Files and responsibilities:

- `useMediaPipeTracking.ts` — Runs MediaPipe face landmark and gesture models in a separate RAF loop. Exposes a `trackingRef` with pose and blendshape data and a hidden `videoRef`. This is intentionally ref-counted to avoid React re-renders.
- `useVRMFace.ts` — Computes and applies VRM expression (blendshape) targets using audio analyser data and MediaPipe overrides. Exports `tick(now, delta)` and a `curExpr` ref with smoothed viseme values.
- `useVRMPose.ts` — Drives bone rotations (spine, chest, neck/head, arms) and exposes a `tick(delta, now, isSpeaking, headReact, curAa)` plus `jitterObj` for lookAt targeting.
- `useVRMVoice.ts` — Manages WebAudio context, microphone capture, analyser node, and TTS calls. Exposes control handlers and an `analyserRef` used by `useVRMFace`.
- `useInterviewSession.ts` — High-level session state: problem selection, chat messages, editor state and message sending (routes to live if available).
- `useLiveInterview.ts` — Integrates with the live interview service (socket/gateway, audio streaming and TTS). (See `services/` for the gateway/service code.)
- `useTheme.ts` — Simple theme toggler that flips `light`/`dark` classes on the document root.

Guidelines:
- Hooks return refs for values that are read inside rendering loops (e.g., Three.js `useFrame`) to avoid re-renders.
- Prefer `tick` functions that are called from a single `useFrame` loop (ownership clarity between face and pose).

Where to start:
- If you want to tweak lip-sync, inspect `useVRMFace.ts`.
- If you need to change bone targets (T-pose, arm hang), update `useVRMPose.ts`.