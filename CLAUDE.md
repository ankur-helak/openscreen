# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OpenScreen is a cross-platform (macOS / Windows / Linux) desktop screen recorder and
video editor — an open-source Screen Studio alternative. It is an **Electron + React +
TypeScript** app: Vite builds the renderer, `vite-plugin-electron` builds the main/preload
processes, and `electron-builder` packages installers. Node is pinned to **22.x / npm 10.x**
(`.nvmrc`, `package.json#engines`).

## Read these first

The repo carries detailed docs — prefer them over re-deriving conventions:

- **`docs/coding-style.md`** — the authoritative style/conventions guide (formatting,
  naming, TS/React patterns, IPC, lib, i18n, testing). Follow it. The guiding rule is
  **match the surrounding code**.
- **`docs/architecture/native-bridge.md`** — the native-bridge design (the preferred path
  for new native features).
- **`docs/tests/writing-tests.md`** — testing guide (three tiers, placement, mocking).
- **`docs/engineering/*-native-recorder-roadmap.md`** and **`docs/testing/*-native-cursor.md`**
  — platform capture/cursor specifics.

**Folder-scoped guidance.** `electron/`, `scripts/`, and `src/` each have their own `CLAUDE.md`
with area-specific context; Claude Code loads them automatically when you work in those folders.
**Maintenance convention:** when you change a folder's structure, commands, conventions, or the
architecture described in its `CLAUDE.md` (including this root file), update that file in the same
change.

## Commands

```bash
npm run dev              # Vite dev server + Electron (hot reload)
npm run lint             # Biome check (format + lint) — CI gate
npm run lint:fix         # Biome autofix
npx tsc --noEmit         # Type check — CI gate (no separate npm script)
npm run test             # Vitest unit tests (jsdom), single run
npm run test:watch       # Vitest watch mode
npm run test:browser     # Vitest in real Chromium (WebCodecs/MediaRecorder/Pixi/WebGL)
npm run test:e2e         # Playwright E2E (full Electron flows)
npm run i18n:check       # Locale key parity vs `en` — run manually; NOT yet in CI/pre-commit
npx vite build           # Renderer+main build only (CI build gate; no installer)
```

Run a **single unit test**: `npx vitest run src/lib/exporter/frameRenderer.test.ts`
or filter by name: `npx vitest run -t "computes layout"`.
Browser-tier single file: `npx vitest --config vitest.browser.config.ts run <file>`.

**Building installers** (requires native helpers to be compiled first):

```bash
npm run build:mac        # build:native:mac (Swift) → tsc → vite build → electron-builder --mac
npm run build:win        # build:native:win (C++/WGC) → ... → electron-builder --win
npm run build:linux      # tsc → vite build → electron-builder --linux (no native helper)
```

The bare `npm run build` runs `tsc && vite build && electron-builder` (current platform) but
does **not** compile native helpers — use the per-platform scripts above when capture matters.

**Before opening a PR**, ensure green locally: `npm run lint && npx tsc --noEmit && npm run test`
(add `npm run test:browser` if you touched export/render code, `npm run i18n:check` if you
touched user-facing strings). Husky runs `lint-staged` (`biome check`) on commit — don't use
`--no-verify`. CI gates PRs to `main` on lint, typecheck, unit+browser tests, and build.

## Architecture big picture

**Two compilation surfaces with different rules:**

- `src/` — the **renderer** (React). Uses the `@/*` → `src/*` path alias; always import via
  `@/...`, never deep relative paths.
- `electron/` — the **main process + preload**. Uses **relative imports** (not covered by the
  alias) and is a separate build. It may import shared *types* from `src/` (e.g.
  `src/native/contracts.ts`, `src/lib/shortcuts.ts`).

**Multi-window model.** A single renderer bundle serves several `BrowserWindow`s,
distinguished by a `?windowType=` query param read in `src/App.tsx`: `hud-overlay`,
`source-selector`, `countdown-overlay`, and the default `editor`. Windows are created by
factory functions in `electron/windows.ts` / `electron/main.ts`. Security is locked down
(`contextIsolation: true`, `nodeIntegration: false`) on every window — do not weaken this.

**Renderer ⇄ main has two IPC styles** (see coding-style §6):

1. **Legacy** individual channels in `electron/ipc/handlers.ts` (`ipcMain.handle("kebab-name")`,
   flat `{ success, error?, ... }` envelopes). Hundreds exist; maintain their style when editing.
2. **Native bridge** (preferred for new native features): one `native-bridge:invoke` channel.
   Shared contracts in `src/native/contracts.ts`, renderer facade `src/native/client.ts`,
   transport `electron/ipc/nativeBridge.ts`, main-process services in
   `electron/native-bridge/services/*`, state in `electron/native-bridge/store.ts`. Layering:
   `adapter (platform) → service (state/orchestration) → transport (single IPC) → client (renderer)`.
   Platform dispatch via `factory.ts` switching on `process.platform`.

**Native capture helpers** are child processes, not Electron APIs:
- macOS: Swift **ScreenCaptureKit** (`electron/native/screencapturekit/`).
- Windows: C++ **Windows Graphics Capture** (`electron/native/wgc-capture/`).
- Linux: no native helper — capture goes through the browser/WebRTC pipeline.

They communicate over **newline-delimited JSON on stdio** (control commands `pause\n` /
`resume\n` / `stop\n` over stdin). Prebuilt binaries live in `electron/native/bin/<platform-arch>/`;
the runtime resolves them by candidate list (env override → local build → packaged `bin` →
resources, handling `.asar` unpacking). This is why capture features differ by OS (see README
"Platform differences").

**Editor & export pipeline (`src/`):**
- `src/components/video-editor/` is the largest feature. `VideoEditor.tsx` owns editor state
  and **prop-drills** it into panels (intentional — no Redux/Zustand; Context is reserved for
  `I18nContext`/`ShortcutsContext`). Undo/redo is the custom `useEditorHistory` hook
  (past/present/future). Pure rendering math lives in `video-editor/videoPlayback/`.
- `src/lib/` is the core engine: `exporter/` (the MP4/GIF pipeline — `VideoExporter`,
  `FrameRenderer`, `muxer`, decoders, built on `pixi.js`, `mediabunny`, `mp4box`, WebCodecs),
  `captioning/` (on-device transcription via `@xenova/transformers` in a worker), `cursor/`
  (smoothing/themes). Classes for stateful pipelines, pure functions for transforms.

**On-device captioning gotcha (Vite).** `@xenova/transformers` statically imports Node
`fs`/`path`/`url` and `onnxruntime-node`. `vite.config.ts` aliases these to stubs in
`src/lib/vite-stubs/` so the renderer bundle stays web-only, and the captioning worker uses
`format: "es"` (it code-splits via dynamic import). Don't remove those aliases.

**Production build strips logs.** `vite.config.ts` sets terser `drop_console` and drops
`console.log`/`console.debug` — so logging meant to survive in prod must use `console.warn`/
`console.error`/`console.info` (and always tag with `[Component]`, per coding-style §7).

## Internationalization

Custom lightweight i18n (no i18next). Renderer translates via `useScopedT(namespace)` /
`useI18n()` (`src/contexts/I18nContext.tsx`); the **main process has its own minimal copy**
(`electron/i18n.ts`, `mainT`) for native menus/dialogs — keep both in sync. Locales are one
JSON per namespace per locale under `src/i18n/locales/<locale>/<namespace>.json`, with `en`
as baseline. **Any user-facing string must be added to all locales**; verify with
`npm run i18n:check`.
