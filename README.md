<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# DevInterview.AI — Repository Overview & Developer Guide

This repository contains a small React + TypeScript app that runs a code interview UI with
an embedded VRM avatar preview. The avatar uses MediaPipe for face tracking, Three.js +
@pixiv/three-vrm for rendering, and a WebAudio-based pipeline for lip-sync and TTS.

This README explains the architecture, where code lives, the important APIs (hooks and
components), and how/when to modify parts of the system.

Quick start
1. Install dependencies:

```bash
npm install
```

2. Start the dev server:

```bash
npm run dev
```

3. Open the app at `http://localhost:3000`.

High-level architecture
- UI: React components in `components/` (editor, transcript, avatar preview).
- Hooks: side-effect and runtime logic in `hooks/` (MediaPipe tracking, VRM face/pose, audio/TTS).
- Services: network glue for model APIs and live interview gateway in `services/`.
- Types & utils: shared types (`types/`) and helper functions (`utils/`).
- Public: static assets (VRM model, MediaPipe WASM) in `public/`.

Directory map (short)
- `components/` — UI + small 3D components. Key file: `components/AvatarInterviewer.tsx` (embedded VRM preview).
- `hooks/` — Core runtime logic. Key files: `useMediaPipeTracking.ts`, `useVRMFace.ts`, `useVRMPose.ts`, `useVRMVoice.ts`.
- `services/` — API clients (`geminiService.ts`, `liveService.ts`, `modelGateway.ts`).
- `types/` — Domain types for chat and interview problems.
- `public/` — `Anurag.vrm` and `mediapipe/wasm` (WASM assets served from here).

How data flows (runtime)
1. `useMediaPipeTracking` obtains camera frames and produces a `trackingRef` with head pose,
    blendshapes (eye blink, jawOpen, mouthSmile), and gesture flags. It runs in its own
    requestAnimationFrame loop (separate from Three.js) and writes to refs (no React re-renders).
2. `useVRMVoice` manages microphone / TTS + creates an `AnalyserNode` referenced by `analyserRef`.
3. The 3D canvas component (`VRMHead` inside `components/AvatarInterviewer.tsx`) loads the VRM
    and runs a per-frame loop that calls `face.tick(...)` then `pose.tick(...)` and finally
    `vrm.update(delta)`.
4. `useVRMFace` reads audio bands from `analyserRef` and MediaPipe overrides from `trackingRef`
    to compute viseme + expression targets and applies them to the VRM expression manager.
5. `useVRMPose` drives bone rotations (spine, chest, neck, arms) and uses a small `jitterObj`
    as the VRM `lookAt.target` for natural head/eye motion.

Key developer files & APIs

1) `components/AvatarInterviewer.tsx`
- Purpose: small embedded VRM preview + capture API.
- Important exports:
   - Default component is `forwardRef` and exposes `captureWebcamFrame(): string | null`.
- Typical usage (in `App.tsx`):

```tsx
const avatarRef = useRef<AvatarInterviewerHandle>(null);
// later: avatarRef.current?.captureWebcamFrame()
```

2) `hooks/useMediaPipeTracking.ts`
- Exports:
   - `videoRef: RefObject<HTMLVideoElement>` — mount this hidden video element in JSX.
   - `trackingRef: RefObject<TrackingData>` — read this from Three.js `useFrame` (no re-renders).
   - `startTracking()`, `stopTracking()`, `loadModels()` and `status`/`statusMsg`.
- `TrackingData` fields: `headPitch`, `headYaw`, `headRoll`, `jawOpen`, `eyeBlinkLeft`, `eyeBlinkRight`, `mouthSmile`, `handToMouth`, `isGiggling`, `motionEnergy`, `isBored`, etc.

3) `hooks/useVRMFace.ts`
- Purpose: compute visemes/blink/secondary expressions and apply to VRM.
- Call signature (current):

```ts
useVRMFace({
   vrmRef: RefObject<VRM|null>,
   analyserRef: RefObject<AnalyserNode|null>,
   trackingRef: RefObject<TrackingData>,
   emotionMode: 'neutral'|'angry'|'happy'|'sad',
   behaviorMode: 'neutral'|'loudLaugh'|...,
});
```

- Returns:
   - `tick(now: number): { isSpeaking: boolean; headReact: boolean }` — call each frame.
   - `curExpr: RefObject<Record<EK, number>>` — smoothed viseme/expression values, e.g. `curExpr.current.aa`.

Notes: the hook uses `getByteTimeDomainData` and `getByteFrequencyData` on the provided analyser
to compute RMS and frequency bands, then maps bands → visemes. MediaPipe blendshapes override
audio where available.

4) `hooks/useVRMPose.ts`
- Purpose: drive bone rotations for spine, chest, neck/head, arms and expose a small jitter object.
- Call signature (current implementation):

```ts
const pose = useVRMPose();
// returns { tick: (vrm,... ) => void, jitterObj: RefObject<Object3D> }
```

Details: Internally `tick` computes breathing, idle sway, behavior-driven poses (laugh, shy,
guilty), nod/shake one-shot gestures, and sets normalized upper-arm Z targets to avoid T-pose.

5) `hooks/useVRMVoice.ts`
- Purpose: audio lifecycle (mic, analyser), synthesis/TTS and control handlers used by UI.
- Exposes: `analyserRef`, `audioMode` state, `inputText` and `isSpeakingText`, and handlers:
   `handleMic()`, `handleStop()`, `handleSynth()`, `handleTTS()`, etc.

6) `services/geminiService.ts` and `services/liveService.ts`
- These provide network helpers for calling the Gemini model endpoints and the live interview
   gateway. Keep API keys and sensitive endpoints out of client-side builds; for production move
   model calls behind a server-side gateway.

Run / Build / Deploy
- Dev server: `npm run dev` (vite)
- Production build: `npm run build`
- Preview production build: `npm run preview`

Common pitfalls & troubleshooting
- TypeScript typed-array complaints: calls to `AnalyserNode.getByteTimeDomainData`/`getByteFrequencyData`
   may raise typing issues depending on your lib settings. Ensure `DOM` is in `tsconfig.lib` and
   use `Uint8Array` for buffer types.
- Tailwind at-rule warnings: if your linter flags `@tailwind` rules, ensure the PostCSS/Tailwind
   config is wired to the build pipeline (Vite + plugin).
- Hook signature mismatches: during refactors the `tick` signatures between `useVRMFace`,
   `useVRMPose`, and their callsites may drift. If you see compile errors, align the callsite
   to the hook's current TypeScript signature; the directory READMEs contain the intended API.

Notes on modifying the avatar/animations
- To change neutral arm hang or fix a T-pose, update constants in `hooks/useVRMPose.ts` (e.g.
   `R_DOWN` / `L_DOWN`) — these set the normalized upper-arm Z rotation targets.
- To change lip-sync tuning, edit `EMOTION_PROFILES` and `BAND_AMP` in `hooks/useVRMFace.ts`.
- To swap the VRM model, replace `public/Anurag.vrm`. Ensure the humanoid bones and expression
   names match expectations (VRM expression preset names and normalized bone accessors).

Developer tips
- Read-only refs: many hooks return refs (`trackingRef`, `analyserRef`, `curExpr`) because these
   are read by the Three.js render loop — mutating refs avoids React re-renders and keeps the
   renderer performant.
- Order of updates: call `face.tick()` before `pose.tick()` inside `useFrame` so the jaw/lips
   computed by the face layer can influence head/neck pose smoothly.

Known issues / TODOs
- There are a few callsite vs hook signature mismatches left from refactors — these
   are described inline in component/hook files and should be resolved by aligning the
   `tick(...)` parameters (face vs pose). Search the repo for `tick(` to find remaining
   mismatch locations.

If you'd like
- I can produce a per-file, line-by-line annotated README (one markdown per source file).
- I can also run the TypeScript diagnostics and fix remaining callsite signature issues.

Thanks — if you want a deeper walkthrough of a particular file (for example
`hooks/useVRMFace.ts`), tell me which file and I'll expand the README with code
snippets and step-by-step execution traces.
