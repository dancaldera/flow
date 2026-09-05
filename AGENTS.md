# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project

Flow — lean open-source push-to-talk dictation for macOS. Electron + TypeScript, plain `tsc` build (no bundler), pnpm. Hold `fn` (native Swift helper) or `⌥Space` (fallback), audio → STT provider → paste at cursor.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check   # tsc --noEmit — run after every edit
pnpm test    # vitest run — unit tests only, fast
pnpm build   # tsc emit + CJS-prelude strip; required before pnpm start
pnpm dev     # watch loop: rebuild + restart Electron on change
pnpm start   # one-shot build and run the app
pnpm run package  # electron-builder DMG (unsigned), outputs to release/
```

There is no linter/formatter configured — `biome.json` exists but no script wires it; do not add one unprompted.

## Architecture

- `src/main.ts` — app lifecycle, tray, hold/release orchestration, timers.
- `src/main/pillWindow.ts` — floating pill geometry (pure, unit-tested: placement, Dock/fullscreen clamp).
- `src/main/permissions.ts`, `src/main/settings.ts` — macOS permissions, provider settings, keychain.
- `src/services/stt.ts` — STT provider seam (`SttProvider`); adding a provider = new class, no rewrites.
- `src/renderer.ts` + `index.html` + `styles/pill.css` — pill UI + mic capture. The renderer loads as a plain `<script src>` — it CANNOT import modules compiled to CJS (no `require`); keep it dependency-free or the build's strip step fails.
- `src/ipc.ts` — shared IPC channel names + types; safe to import from main AND renderer (pure types/constants only).
- `swift/` — native helpers (`fn` tap, fullscreen check); prebuilt binaries are committed, `asarUnpack`ed at package time.
- `src/main/updates.ts` — in-app updater: pure helpers (version compare, asset pick) unit-tested; `checkForUpdates()` is the tray-menu flow (public GitHub API, no token).
- `test/` — Vitest. Tests exist for `pillWindow.ts`, `permissions-fn`, `stt`, `updates`. Pure logic only — no Electron runtime in tests.

## Conventions

- Electron main-process modules use CJS-style interop (`import` compiled by tsc to `require`).
- UI strings for state go through `setState()` in `src/main.ts`; renderer mirrors via `window.flow.onState`.
- Shared constants between main and renderer live in `src/ipc.ts`; if the renderer needs one it cannot import, duplicate it with a comment pointing at the source (see `ERROR_VISIBLE_MS` in `src/renderer.ts`).
- Pill geometry constants (`PILL_HEIGHT`, `PILL_BOTTOM_GAP`, `FULLSCREEN_PAD`) in `src/main/pillWindow.ts` are asserted in `test/pillWindow.test.ts` — update tests when changing placement.

- Apps are **ad-hoc signed** (`-c.mac.identity=-`, hardenedRuntime off). Do NOT sign with hardened runtime without a real cert: library validation then rejects the Electron Framework ("different Team IDs" → app won't launch). Do NOT revert to `identity=null`: unsigned quarantined apps get the unrecoverable Gatekeeper "damaged" error; ad-hoc gets the bypassable "unidentified developer" one.

## Verification

- `pnpm check && pnpm test` after every change; both must pass before committing.
- Behavior changes to the pill/tray: run `pnpm dev` and exercise the real UI — unit tests do not cover Electron runtime.
- Packaging changes: `pnpm run package` must produce DMGs in `release/`.

## Git & releases

- Main branch, small commits, push directly (no PR required for solo work).
- Versions: semver in `package.json`. Release = `pnpm version patch|minor|major && git push --follow-tags` → CI builds DMGs and publishes a GitHub Release. Tag must match `package.json` or the release job fails.
- CI: PRs/pushes to `main` run check+test+build; pushes to `main` also produce installable DMG artifacts (`.github/workflows/ci.yml`, `.github/workflows/release.yml`).
- Builds are unsigned (ad-hoc); do not add signing secrets or config without an explicit ask.

## Gotchas

- `dist/` is build output (gitignored); `release/` is packaging output (gitignored).
- Renderer is a plain script: importing CJS modules breaks `scripts/strip-cjs-prelude.js`.
- The fullscreen sidecar (`swift/flow-fullscreen-check`) is ground truth for pill placement; Electron's cached screen metrics go stale — do not replace the sidecar with `screen` module reads.
