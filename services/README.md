# services/

This folder contains thin wrappers and adapters for external APIs and the live interview gateway.

Files:

- `geminiService.ts` — Client helpers to call the Gemini chat/completion APIs used to generate model responses. Includes helpers for building the prompt context and calling the server-side endpoint.
- `liveService.ts` — Live interview service client: handles WebSocket or streaming setup used during a live interview session, plus methods to send text and play TTS audio on the candidate side.
- `modelGateway.ts` — Lightweight gateway to route requests between the UI and cloud model endpoints (used by the live interview flow). May include retry/backoff logic and audio chunking helpers.

Notes:
- These files intentionally keep network logic separate from UI/state hooks. Update API keys and endpoints in `constants.ts` or `.env` when configuring deployments.
- For production, secure API keys and replace direct browser calls with a server-side gateway where necessary.