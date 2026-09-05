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
pnpm install
pnpm test && pnpm check
pnpm dev    # rebuild + restart the app on every change (hot reload)
pnpm start  # one-shot build and run
```

On first run, Flow opens a two-step setup window:

1. Choose one transcription provider, pick a transcription model from its searchable list (or keep the default), optionally fix the spoken language (auto-detect by default), and enter its API key. Once a key is saved for a provider, later changes to model or language need no key — leave the field empty to keep it, or enter a new key to replace it.
2. Enable **Microphone** in-app, then open **Accessibility** Settings and toggle Flow on (required for the `fn` key tap and paste-at-cursor). If `fn` still does nothing, add Flow under **Input Monitoring** too.

The pill, shortcuts, and fn helper start only after both setup steps are complete. Reopen the flow anytime from tray menu → **Setup & permissions…**. Usage instructions live in the app under tray menu → **How to use Flow…** — the floating pill follows the Dock (just above it when visible, hugging the bottom edge when hidden or fullscreen), rests as a subtle empty gray pill when idle, and fills with status while listening / transcribing / reporting an error.

Credentials are stored separately from `settings.json` using Electron `safeStorage` (macOS Keychain); they are never exposed to the renderer. For development, these environment variables are also recognized: `CLOUDFLARE_AI_GATEWAY_TOKEN` (or `CLOUDFLARE_API_TOKEN`), `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `DEEPGRAM_API_KEY`, and `ASSEMBLYAI_API_KEY`.

| Provider | Selectable models (* = default) | Additional setup |
| --- | --- | --- |
| Cloudflare AI Gateway | `@cf/openai/whisper-large-v3-turbo`*, `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en` | Account ID and optional gateway ID |
| OpenRouter | `openai/whisper-1`*, `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe`, `deepgram/nova-3` | API key |
| OpenAI | `gpt-4o-mini-transcribe`*, `gpt-4o-transcribe`, `whisper-1` | API key |
| Vercel AI Gateway | `openai/whisper-1`*, `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe` | API key |
| Deepgram | `nova-3`*, `nova-2`, `nova-3-medical`, `nova-2-meeting`, `nova-2-phonecall`, `whisper-large` | API key |
| AssemblyAI | `universal-3-5-pro`* (→ `universal-2` fallback per request), `universal-2` | API key |

Each model offers only the languages its API accepts — the picker shows Auto-detect plus that model's supported list, and anything outside it falls back to auto-detect. Notes:

- Deepgram `nova-3` additionally offers `multi` for multilingual code-switching; the domain-tuned models (`nova-3-medical`, `nova-2-meeting`, `nova-2-phonecall`) are English-only.
- AssemblyAI `universal-3-5-pro` covers 18 languages and falls back to `universal-2` (≈99 languages) automatically per request.
- Vercel AI Gateway models are auto-detect only: the current request wrapper sends no language field.

### Cloudflare Gateway (2 min)

1. Dash → AI Gateway → create gateway `flow` → note `account_id` + `gateway_id`.
2. Workers AI is the default model — no extra key beyond a Gateway token. Or add an OpenAI key as fallback route.
3. Enter the token, account ID, and gateway ID in the first-run setup window. In development, `CLOUDFLARE_AI_GATEWAY_TOKEN` also works.

### True `fn` hold (optional build)

```bash
swiftc -o swift/flow-fn-listener swift/fn-listener.swift -framework Cocoa
swiftc -o swift/flow-fullscreen-check swift/fullscreen-check.swift -framework Cocoa
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


## Versioning & releases

Versions follow semver in `package.json`; git tags (`v*`) drive releases.

- **PRs / pushes to `main`** — CI typechecks, tests, and compiles. Every push to `main` also packages an unsigned macOS DMG (arm64 + x64) as a run artifact: open the Actions run → Artifacts → installable `.dmg`.
- **Releases** — cut one by bumping the version and pushing the tag:

```bash
pnpm version patch   # or minor / major — commits and tags vX.Y.Z
git push --follow-tags
```

Builds are ad-hoc signed (no Apple Developer cert). macOS Gatekeeper blocks first launch with "cannot verify the developer" — right-click the app → **Open**, or System Settings → **Privacy & Security** → **Open Anyway**. After reinstalling, macOS may ask once to re-grant Microphone/Accessibility and to re-enter the provider API key (the signing identity changed). To distribute with zero prompts you need a Developer ID certificate + notarization: add the cert secrets and electron-builder signing env to `.github/workflows/release.yml`.

## Privacy

Mic audio never leaves the machine except the single STT POST. Keys live in Keychain/env, never in git.
