# CLAUDE.md — `scripts/` (build + native test scripts)

> **Maintenance:** Keep this file current. When you change this folder's structure, commands,
> conventions, or the architecture described here, update this file in the same change.

Standalone Node/bash scripts for building native helpers, fetching caption assets, validating
i18n, and exercising the native capture pipelines. Most are invoked through `package.json`
scripts — cross-reference there for exact wiring.

## Format

- **Node ESM `.mjs`** for everything, **except**:
  - `before-pack.cjs` — CommonJS (electron-builder `beforePack` hook export).
  - `build_macos.sh` — bash; produces the signed `.dmg`, sources `.env` for signing config.

## What each script does

**Native helper builds**
- `build-macos-screencapturekit-helper.mjs` — compiles the Swift ScreenCaptureKit + cursor
  helpers (SwiftPM). `npm run build:native:mac`; runs as part of `build:mac`. No-ops off macOS.
- `build-windows-wgc-helper.mjs` — compiles the C++ WGC helper via CMake/MSVC (locates
  `vcvarsall`). `npm run build:native:win`; runs as part of `build:win`. Outputs to
  `electron/native/bin/win32-x64/`.

**Caption assets**
- `fetch-caption-model.mjs` — idempotently downloads the Whisper-tiny model + ORT wasm into
  gitignored `caption-assets/` (shipped via electron-builder `extraResources`) so captioning
  works offline. Invoked automatically by `before-pack.cjs` on every package build.

**TTS (voiceover) assets**
- `fetch-tts-model.mjs` — idempotently downloads the Kokoro-82M (q8) model + curated English
  voice `.bin` files + `@huggingface/transformers` ORT wasm into gitignored `tts-assets/`
  (shipped via electron-builder `extraResources`) so on-device voiceover synthesis works offline.
  Mirrors `fetch-caption-model.mjs`; the voice id list must stay in sync with
  `src/lib/tts/voices.ts`. Invoked automatically by `before-pack.cjs` on every package build.

`before-pack.cjs` runs **both** `fetch-caption-model.mjs` and `fetch-tts-model.mjs` before packaging.

**i18n**
- `i18n-check.mjs` — validates locale key parity against the `en` baseline across all
  namespaces. `npm run i18n:check`. (Not yet wired into CI/pre-commit — run manually.)

**Native test / inspection harnesses**
- `test-windows-wgc-helper.mjs` — drives the WGC helper; many `npm run test:wgc-*:win` variants
  toggle window/system-audio/microphone/webcam capture.
- `test-windows-native-cursor.mjs` (`test:cursor-native:win`) — exercises native cursor capture.
- `inspect-native-cursor-click-bounce.mjs` — analyzes a recorded cursor JSON/video for click
  bounce timing.
- `capture-openscreen-preview.mjs` — launches the built Electron app via Playwright to capture
  preview frames from a fixture recording.

## Conventions

- Resolve the repo root from `fileURLToPath(import.meta.url)` (no hardcoded paths).
- **Env-var overrides** for binary paths and parameters (e.g. `OPENSCREEN_WGC_CAPTURE_EXE`,
  duration/fps knobs); document the env vars you add.
- **Platform guards**: exit cleanly (`process.exit(0)`) when the host OS doesn't match, so
  cross-platform builds/CI don't fail.
- Tagged `console.*` logging; asset-producing scripts must stay **idempotent** (safe re-runs /
  CI cache hits).
