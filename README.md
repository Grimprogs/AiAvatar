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
│   ├── AvatarInterviewer.tsx        # ← 3D avatar + real-time lip-sync (NEW)
│   ├── ChatPanel.tsx                # Chat transcript + input
│   ├── CodeEditor.tsx               # Monaco-style textarea editor
│   └── LiveControls.tsx            # Start/stop Gemini Live button
├── hooks/
│   ├── useInterviewSession.ts       # Problem state, code, language, messages
│   ├── useLiveInterview.ts          # Gemini Live audio connection + volume
│   └── useTheme.ts                  # Light/dark toggle
├── services/
│   ├── geminiService.ts             # Chat (non-live) Gemini calls
│   ├── liveService.ts               # Gemini Live WebSocket service
│   └── modelGateway.ts             # Model routing helper
├── types/ types.ts constants.ts     # Shared types and problem bank
└── utils/audioUtils.ts              # Audio helpers
```

---

## Avatar Interviewer — `components/AvatarInterviewer.tsx`

### How to reach it
A **🤖 Avatar** button in the top-right of the app header toggles between the code editor and the full-screen avatar view. Clicking **💻 Code Editor** returns to the original layout.

### GLB / Avatar
- Model: Ready Player Me avatar
- URL: `https://models.readyplayer.me/69a5e7f58c4f96df517f3654.glb?morphTargets=ARKit`
- **`?morphTargets=ARKit` is mandatory.** Any other value (e.g. `Oculus Blend Shapes`) silently produces a GLB with no mouth targets — only eye blinks would work.

### Confirmed ARKit morph targets present on this mesh
```
jawOpen
mouthFunnel      mouthPucker
mouthSmileLeft   mouthSmileRight
mouthUpperUpLeft mouthUpperUpRight
mouthLowerDownLeft mouthLowerDownRight
cheekPuff
eyeBlinkLeft     eyeBlinkRight
browInnerUp
```

### Lip-sync pipeline
1. **Mic** — `getUserMedia` → `AudioContext` → `AnalyserNode` (`fftSize=2048`, `smoothingTimeConstant=0.45`)
2. **RMS** (time-domain) — true amplitude; silence threshold = `0.015`
3. **3-band FFT** — `frequencyBinCount` (1024 bins ≈ 21.5 Hz each) split into equal thirds:

| Band | Range | Drives |
|------|-------|--------|
| `lowFreq` (0 – ⅓) | 0 – 7.3 kHz | `mouthFunnel`, `mouthPucker` (rounded /o/ /u/) |
| `low+mid` weighted | — | `jawOpen` primary driver (scales with volume; shout → wide open) |
| `highFreq` (⅔ – end) | 14 – 22 kHz | `mouthSmileLeft/Right` (sibilants /s/ /z/ spread lips) |
| sub-200 Hz (bins 0–10) | — | `cheekPuff` (bilabials /b/ /p/ /m/) |
| RMS onset spike | — | `browInnerUp` (syllable emphasis) |
| jaw-derived | — | `mouthUpperUp*`, `mouthLowerDown*` |

4. **Smoothing** — `THREE.MathUtils.lerp(current, target, alpha)` per frame with per-target alpha (jaw = 0.28 snappy; cheeks = 0.10 lazy)
5. **Silence** — When `smoothRms < 0.015`, all targets lerp back to 0 (mouth rests closed)

### Other behaviours
- **Random eye blinks** — 130 ms duration, every 1.5–6 s (independent of audio)
- **Idle head sway** — 3-axis sine oscillation; amplitude increases while speaking
- **`OrbitControls`** — drag to orbit, scroll to zoom, pan disabled
- **Suspense fallback** — rotating wireframe torus while GLB loads

### Installed packages (Three.js stack)
```
three  @react-three/fiber  @react-three/drei  @types/three
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

- [ ] Connect AI backend — wire `useLiveInterview` audio output into `AvatarInterviewer` so the avatar lip-syncs to the AI voice (not just the user mic)
- [ ] Text-to-viseme `parseTextToVisemes(text)` — dictionary + word parser ready to implement for transcript-driven animation
- [ ] Oculus viseme support requires a different avatar export pipeline (RPM dashboard → custom export with Oculus preset), not a URL param
