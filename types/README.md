# types/

Type declarations and shared interfaces used across the app.

Files:

- `chat.ts` — Types for chat messages, message roles, and live session state used by `ChatPanel` and session hooks.
- `interview.ts` — Types describing interview problems, languages, and editor metadata.
- `index.ts` — Re-exports used by the rest of the codebase (keeps imports tidy: `@/types`).

Guidelines:
- All public types should be stable; changing them requires aligning all callers in hooks/components.
- Prefer discriminated unions for message types when adding new message metadata (e.g., thinking/streaming flags).