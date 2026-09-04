# Flow — hold `fn`, speak, release. Text lands at your cursor.

Lean open-source push-to-talk dictation for macOS. Floating pill on all Spaces, STT through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) (default route: Workers AI `@cf/openai/whisper-large-v3-turbo`), paste at cursor.

Wispr Flow-style UX, minimal scope: no streaming, no AI rewrite, no accounts.

## How it works

1. Hold `fn` (native helper) or `⌥Space` (fallback) anywhere.
2. Pill appears bottom-center on every Space, even fullscreen (`floating` level, `visibleOnAllWorkspaces`).
3. Release → audio posts to `{gateway}/openai/audio/transcriptions` → text pastes via clipboard save/restore + `Cmd+V` (typing fallback).
4. `Esc` cancels mid-hold.

STT providers implement one seam (`src/services/stt.ts:SttProvider`), so adding Deepgram/OpenAI-local is a new class, not a rewrite.

## Setup

```bash
cd flow
npm install
npm test && npm run check
npm start
```

On first run, Flow opens a two-step setup window:

1. Choose one transcription provider and enter its credentials. Flow assigns the provider's default transcription model automatically.
2. Enable **Microphone** in-app, then open **Accessibility** Settings and toggle Flow on (required for the `fn` key tap and paste-at-cursor). If `fn` still does nothing, add Flow under **Input Monitoring** too.

The pill, shortcuts, and fn helper start only after both setup steps are complete. Reopen the flow anytime from tray menu → **Setup & permissions…**.

Credentials are stored separately from `settings.json` using Electron `safeStorage` (macOS Keychain); they are never exposed to the renderer. For development, these environment variables are also recognized: `CLOUDFLARE_AI_GATEWAY_TOKEN` (or `CLOUDFLARE_API_TOKEN`), `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `DEEPGRAM_API_KEY`, and `ASSEMBLYAI_API_KEY`.

| Provider | Assigned default model | Additional setup |
| --- | --- | --- |
| Cloudflare AI Gateway | `@cf/openai/whisper-large-v3-turbo` | Account ID and optional gateway ID |
| OpenRouter | `openai/whisper-1` | API key |
| OpenAI | `gpt-4o-mini-transcribe` | API key |
| Vercel AI Gateway | `openai/whisper-1` | API key |
| Deepgram | `nova-3` | API key |
| AssemblyAI | `universal-3-5-pro` → `universal-2` fallback | API key |

### Cloudflare Gateway (2 min)

1. Dash → AI Gateway → create gateway `flow` → note `account_id` + `gateway_id`.
2. Workers AI is the default model — no extra key beyond a Gateway token. Or add an OpenAI key as fallback route.
3. Enter the token, account ID, and gateway ID in the first-run setup window. In development, `CLOUDFLARE_AI_GATEWAY_TOKEN` also works.

### True `fn` hold (optional build)

```bash
swiftc -o swift/flow-fn-listener swift/fn-listener.swift -framework Cocoa
npm start   # main auto-detects ./swift/flow-fn-listener
```

Electron alone cannot bind single-`fn`; see [`globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut) limits. The helper uses a `CGEventTap` flags-changed tap (mask `0x800000`).

## Layout

- `src/main.ts` — lifecycle, tray, hold/release orchestration.
- `src/main/pillWindow.ts` — floating overlay recipe (`floating` + `visibleOnAllWorkspaces`).
- `src/services/stt.ts` — provider seam + Gateway client.
- `src/main/inserter.ts` — paste at cursor.
- `src/renderer.ts` + `index.html` + `styles/pill.css` — pill UI + mic capture.
- `swift/fn-listener.swift` — native `fn` tap.
- `test/` — Vitest seam tests.

## Privacy

Mic audio never leaves the machine except the single STT POST. Keys live in Keychain/env, never in git.
