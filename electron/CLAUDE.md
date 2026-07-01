# CLAUDE.md — `electron/` (main process + preload)

> **Maintenance:** Keep this file current. When you change this folder's structure, commands,
> conventions, or the architecture described here, update this file in the same change.

This is the **Electron main process and preload** — a separate compilation surface from the
renderer. Authoritative conventions live in [`../docs/coding-style.md`](../docs/coding-style.md)
(§6 covers Electron/IPC); the native-bridge design is in
[`../docs/architecture/native-bridge.md`](../docs/architecture/native-bridge.md).

## What's different here vs `src/`

- **Relative imports only** — the `@/*` alias is renderer-only and does not apply here. You may
  import shared *types* from `src/` (e.g. `../src/native/contracts.ts`, `../src/lib/shortcuts.ts`).
- This code runs in Node/Electron with full system access; the renderer never does.

## Window model

- A single renderer bundle serves multiple `BrowserWindow`s, created by factory functions in
  `windows.ts` / `main.ts` and distinguished by a `?windowType=` query param
  (`hud-overlay`, `source-selector`, `countdown-overlay`, default `editor`).
- Security is locked on every window: **`contextIsolation: true`, `nodeIntegration: false`** —
  do not weaken. (`webSecurity: false` exists only on the editor window for local file loading;
  don't copy it elsewhere.) The preload exposes a single `window.electronAPI` via `contextBridge`.

## Two IPC styles — prefer the native bridge

1. **Legacy** individual channels in `ipc/handlers.ts`: `ipcMain.handle("kebab-case-name", ...)`
   returning a flat `{ success, error?, canceled?, ...data }` envelope. Hundreds exist; match
   their style when editing them.
2. **Native bridge** (preferred for new native-facing features): one `native-bridge:invoke`
   channel, transport in `ipc/nativeBridge.ts`. Layering:
   `adapter (platform) → service (orchestration + state) → transport (single IPC) → client (renderer)`.
   - Services in `native-bridge/services/*` use constructor DI; state lives in
     `native-bridge/store.ts` (immutable spread updates). Current domains: `transcript`
     (`services/transcriptService.ts` — fs-backed sidecar transcript cache + caption autosave
     drafts under `userData/transcripts/` and `userData/caption-drafts/`, keyed by a video stat
     signature).
   - Platform dispatch via a `factory.ts` switching on `process.platform`
     (`win32` → WGC, `darwin` → ScreenCaptureKit, else telemetry-only fallback).
   - Contracts are shared in `../src/native/contracts.ts`; renderer calls
     `../src/native/client.ts`, never raw IPC.

## Native capture helpers (`electron/native/`)

- macOS: Swift **ScreenCaptureKit** (`screencapturekit/`). Windows: C++ **Windows Graphics
  Capture** (`wgc-capture/`). Linux has no native helper (browser/WebRTC pipeline instead).
- Helpers are **child processes** speaking **newline-delimited JSON over stdio**; control
  commands go over stdin (`pause\n`, `resume\n`, `stop\n`).
- Binaries are resolved by candidate list (env override → local build → packaged
  `bin/<platform-arch>/` → resources, handling `.asar` unpacking). Prebuilt binaries live in
  `electron/native/bin/<platform-arch>/`. Build them via the `scripts/` helpers
  (`npm run build:native:mac` / `build:native:win`).

## i18n in the main process

The main process keeps its own minimal i18n copy (`i18n.ts`, `mainT(...)`) for native menus and
dialogs — keep it in sync with the renderer locales when adding main-process UI strings.
