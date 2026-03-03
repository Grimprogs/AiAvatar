<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# DevInterview AI

An AI-powered coding interview platform with a real-time 3D avatar interviewer, live Gemini audio, a code editor, and a chat transcript panel.

---

## Quick Start

**Prerequisites:** Node.js ≥ 20

```bash
npm install
# Add your Gemini API key:
echo "GEMINI_API_KEY=your_key_here" > .env.local
npm run dev          # → http://localhost:3000
```

> If port 3000 is occupied Vite will auto-increment. Use:
> `npm --prefix "D:\proj\Chehra\DevInterviewAI" run dev`

---

## Project Structure

```
DevInterviewAI/
├── App.tsx                          # Root layout + showAvatar toggle
├── index.tsx                        # React entry — imports index.css
├── index.html                       # No Tailwind CDN; styles via PostCSS
├── index.css                        # @tailwind directives + CSS variables
├── tailwind.config.cjs              # Tailwind v3 config (custom theme tokens)
├── postcss.config.cjs               # PostCSS → tailwindcss + autoprefixer
├── vite.config.ts                   # Vite + path alias "@" → root
├── components/
│   ├── AvatarInterviewer.tsx        # VRM avatar — blend tree, MediaPipe, behaviors
│   ├── ChatPanel.tsx                # Chat transcript + input
│   ├── CodeEditor.tsx               # Monaco-style textarea editor
│   └── LiveControls.tsx             # Start/stop Gemini Live button
├── hooks/
│   ├── useMediaPipeTracking.ts      # Dedicated rAF loop: face + gesture → trackingRef
│   ├── useInterviewSession.ts       # Problem state, code, language, messages
│   ├── useLiveInterview.ts          # Gemini Live audio connection + volume
│   └── useTheme.ts                  # Light/dark toggle
├── services/
│   ├── geminiService.ts             # Chat (non-live) Gemini calls
│   ├── liveService.ts               # Gemini Live WebSocket service
│   └── modelGateway.ts             # Model routing helper
├── public/
│   ├── Anurag.vrm                   # VRoid character asset
│   └── mediapipe/wasm/              # WASM assets (copied from node_modules)
│       ├── vision_wasm_internal.js/wasm
│       └── vision_wasm_nosimd_internal.js/wasm
├── types/ types.ts constants.ts     # Shared types and problem bank
└── utils/audioUtils.ts              # Audio helpers
```

---

## Avatar Interviewer — `components/AvatarInterviewer.tsx`

### How to reach it
A **🤖 Avatar** button in the top-right of the app header toggles between the code editor and the full-screen avatar view. Clicking **💻 Code Editor** returns to the original layout.

### VRM Character
- Model: `public/Anurag.vrm` — VRoid-format character
- Loaded via `GLTFLoader` + `@pixiv/three-vrm` `VRMLoaderPlugin`
- Eye tracking: `vrm.lookAt.target` set to a jitter `Object3D` so eyes are never locked still

---

### Architecture — Two Independent Loops

```
MediaPipe rAF loop                    Three.js useFrame (60 fps)
useMediaPipeTracking.ts          ──►  AvatarInterviewer.tsx
  FaceLandmarker (blendshapes)          │
  GestureRecognizer (hands)    ──ref──► │  LAYER 1  Spine/Chest breathing  (always on)
  trackingRef  (plain object)           │  LAYER 2  Face & Speech           (parallel)
                                        │  LAYER 3  LLM Behavior switch     (overrides)
Web Audio API                  ──ref──►
  AnalyserNode  (mic / synth)
```

MediaPipe runs in its own `requestAnimationFrame` loop completely decoupled from Three.js — neither loop can block the other.

---

### T-Pose Fix (on VRM load)

Arms and hands are set to natural resting angles immediately when the character loads:

| Bone | rz result |
|------|-----------|
| LeftUpperArm / RightUpperArm | ±π/2.5 ≈ ±72° — drops from T-pose |
| LeftLowerArm / RightLowerArm | ±0.08 — slight inward curl |
| LeftHand / RightHand | small palmward curl |

---

### Layer 1 — Always-Alive Base

Targets **Spine** and **Chest** bones only. Never suppressed by any behavior or tracking state.

- **Breathing**: `sin(t × 0.25 × 2π)` — ~4 seconds per breath, amplitude 0.005 rad
- Spine carries 40% of the swell; Chest carries 60%
- **Idle blink timer**: fires every 3–5 s, 140 ms open→close→open cycle

---

### Layer 2 — Face & Speech (Parallel)

Targets the face mesh expressions only. Runs in parallel with Layer 1 bones — no conflict.

#### Audio lip-sync pipeline
1. **RMS** (time-domain) — silence floor `0.015`; `pow(rms, 0.70)` volume curve
2. **3-band FFT** — `fftSize=2048` split into equal thirds:

| Band | Drives |
|------|--------|
| Low (0 – ⅓) | `oh`, `ou` |
| Mid (⅓ – ⅔) | `aa`, `ee` |
| High (⅔ – end) | `ih`, happy boost |

3. All viseme targets multiplied by the active **Emotion Profile** weights before lerp
4. Smoothing: `MathUtils.lerp(cur, target, α)` per frame; α 0.14–0.40 depending on profile

#### MediaPipe blendshape → VRM expression mapping

| MediaPipe | VRM expression |
|-----------|---------------|
| `jawOpen` | `aa` |
| `mouthSmileLeft/Right` avg | `happy` |
| `mouthPucker` | `oh` |
| `mouthFunnel` | `ou` |
| `browInnerUp` | `sad` |
| `eyeBlinkLeft/Right` max | `blink` (replaces clock blinks when tracking active) |

---

### Layer 3 — LLM Action Overrides (`switch(behaviorMode)`)

Overrides neck / head / arm bones. When behavior returns to `'neutral'`, all bones lerp back to resting at α ≈ 0.04–0.10, exposing Layer 1 breathing underneath.

| `behaviorMode` | Head / Neck | Arms | Expressions |
|---|---|---|---|
| `neutral` | gentle idle sway (0.012 rad) | rest | emotion profile baseline |
| `loudLaugh` | neck −0.32 X (arc back), head −0.40, slow Y/Z sway | spread outward, 4.5 Hz bounce | `happy:1.0`, `aa:1.0`, `blink:0.8` |
| `shyGiggle` | neck +0.22 X (look down), +0.12 Z tilt, head averts | **right arm IK to mouth** (elbow bends ~100°) | `happy:0.7`, `blink:0.4` |
| `guilty` | full bow +0.55 X neck, +0.60 X head | both arms slump inward | `sad:0.85` |
| `angry` | forward lean +0.15 X neck, **additive Z-shake** 19 Hz | gestures × 1.4 intensity | `angry:1.0`, `surprised:0.25` |
| `blush` | slight down +0.10, shy tilt +0.08 Z | natural rest | `happy:0.4`, `relaxed:0.9`, `blink:0.3` |

**Module 3 dynamics** (post-bone pass):
- `loudLaugh`: `head.position` vibrates on three incommensurable frequencies (22 / 30.1 / 17.3 Hz), decays to 0 on behavior change
- `angry`: `head.rotation.z += sin(t × 19) × 0.022` additive Z-rattle

---

### Eye Look-At Modes

| Condition | Behaviour |
|---|---|
| `neutral` or `sad` + no tracking | **Nystagmus** — rapid saccades every 0.15–0.45 s within ±35 mm (non-engagement simulation) |
| `shyGiggle` / `blush` | **Lazy follow** — eyes drift slowly toward camera (lerp α × 1.8) |
| `angry` | **Snap** — eyes lock instantly (lerp α × 9) |
| `loudLaugh` | Floaty follow (lerp α × 3.5) |
| Default | Standard micro-jitter: new random goal every 2–4 s |

---

### MediaPipe Face Tracking — `hooks/useMediaPipeTracking.ts`

WASM assets served locally from `public/mediapipe/wasm/` (CDN blocked by strict MIME checking).

| `TrackingData` field | Source |
|---|---|
| `headPitch / Yaw / Roll` | FaceLandmarker geometry → Euler angles, mirrored for avatar |
| `eyeBlinkLeft/Right` | ARKit blendshape direct |
| `mouthSmile / jawOpen / mouthFunnel / mouthPucker` | ARKit blendshapes |
| `browInnerUp / cheekPuff` | drives sad/happy boost |
| `handToMouth` | GestureRecognizer `landmarks[0][8]` (index tip) vs face LM 13 (upper lip), threshold 0.14 |
| `isGiggling` | `handToMouth && mouthSmile > 0.45` |
| `motionEnergy` | rolling RMS of landmark delta between frames |
| `isBored` | `motionEnergy < threshold` for 5 continuous seconds → look-away idle |

---

### UI Controls

| Section | Controls |
|---|---|
| **Behavior** | `😐 Neutral · 😂 Loud Laugh · 🙈 Shy Giggle · 😔 Guilty · 😡 Angry · ☺️ Blush` |
| **Emotion** | Dropdown: `Neutral / Angry / Happy / Sad` — sets viseme profile |
| **Face Tracking** | `📷 Start Face Tracking` → loads WASM + opens webcam on first click |
| **Camera PiP** | `📹 Show Me` → mirrored live webcam overlay (bottom-right of canvas), appears when tracking active |
| **Audio** | `🎤 Mic · ⏹ Stop Audio` |
| **Synth tests** | `🔊 Normal · 😡 Angry · 😊 Happy · 😢 Sad` — local Web Audio oscillator stacks, no external URLs |
| **Head triggers** | `👍 Nod Yes · 👎 Shake No` — 2-second sine-wave animations, highest priority in branch tree |

---

### LLM Hookup (one line each)
```ts
setBehaviorMode('loudLaugh');   // head thrown back, face vibrates, arms bounce
setBehaviorMode('shyGiggle');   // hand covers mouth, neck tilts, shy expressions
setBehaviorMode('guilty');      // full head bow, arms slump inward
setBehaviorMode('angry');       // forward lean, Z-rattle, angry expressions
setBehaviorMode('blush');       // dreamy tilt, half-closed eyes
setBehaviorMode('neutral');     // graceful lerp back, Layer 1 breathing visible
```

MediaPipe auto-triggers: `handToMouth + smile → shyGiggle`, `loud RMS → loudLaugh`.

---

### Installed packages (Three.js / VRM / MediaPipe stack)
```
three  @react-three/fiber  @react-three/drei  @types/three
@pixiv/three-vrm
@mediapipe/tasks-vision
tailwindcss@3  postcss  autoprefixer
```

---

## Tailwind Setup (PostCSS — NOT CDN)

Tailwind is compiled at build time via PostCSS. **Do not re-add the CDN `<script>` to `index.html`.**

- `tailwind.config.cjs` — content paths + custom color tokens (`app`, `panel`, `subtle`, `primary`, `secondary`, `accent`)
- `postcss.config.cjs` — wires tailwindcss + autoprefixer
- `index.css` — `@tailwind base/components/utilities` + CSS variable definitions + Google Fonts import
- `index.tsx` — `import './index.css'` (entry point)

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Required for Gemini Live + chat features |

Set in `.env.local` at project root.

---

## Known Issues / Next Steps

- [ ] Connect Gemini Live audio output → `analyserRef` so the avatar lip-syncs to AI voice (not just mic/synth)
- [ ] Wire LLM sentiment response → `setBehaviorMode(...)` for fully automatic behavior switching
- [ ] Replace dropdown emotion selector with auto-detect from MediaPipe / LLM response
- [ ] Add spine/shoulder physics for hair and clothing (VRM spring bones via `vrm.update(delta)` already called)
- [ ] Mobile: MediaPipe WASM is heavy (~11 MB); consider lazy-loading or SIMD detection
