# public/

Static assets served by the dev server and included in builds.

Notable files:

- `Anurag.vrm` — The VRM avatar model used by `AvatarInterviewer` and the embedded preview components.
- `mediapipe/wasm/*` — Local copies of the MediaPipe WASM runtime and glue scripts used by `useMediaPipeTracking`. These are served directly from `/mediapipe/wasm/` to avoid CDN MIME issues.

Guidelines:
- Large binary assets (models, WASM) belong in `public/` so the browser can request them directly at runtime.
- If replacing the VRM, make sure the model's humanoid/bone naming matches expectations (normalized bones are used in `useVRMPose`).