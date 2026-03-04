# components/

This folder contains React UI and 3D components used by the app.

Files:

- `AvatarInterviewer.tsx` — Small embedded VRM avatar preview. Loads the VRM model, wires `useVRMFace` and `useVRMPose`, runs the per-frame loop (face.tick -> pose.tick -> vrm.update), and exposes a capture API via `forwardRef`.
- `ChatPanel.tsx` — Transcript UI: lists messages, provides input box and send button, shows thinking state and simple controls.
- `CodeEditor.tsx` — Lightweight code editor UI with a hidden canvas capture API for vision/TTS. Handles language selection and theme toggle.
- `LiveControls.tsx` — Small control UI for live interview connection and visual audio meter.

How to read these files:

- `AvatarInterviewer.tsx` focuses on the 3D preview and uses the `useMediaPipeTracking` hook; it is intentionally decoupled from audio/voice logic.
- `CodeEditor.tsx` and `ChatPanel.tsx` are plain React components with minimal external dependencies — useful entry points for customizing UI.

Usage:
- Components are composed in `App.tsx`.

Notes:
- Keep logic-heavy behavior inside hooks (see `hooks/`), and keep components focused on rendering and high-level orchestration.