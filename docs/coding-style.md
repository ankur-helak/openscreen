# Coding Style & Practices

This document describes the coding conventions actually used in the OpenScreen
codebase, derived from analyzing the whole repo (`src/`, `electron/`, configs,
tests, i18n). It is meant to be read by anyone — human or AI — about to write or
review code here. The guiding principle is **match the surrounding code**: this
codebase is internally consistent, and new code should be indistinguishable from
existing code.

When this document and the actual code disagree, the code wins — update this doc.

---

## 1. Tooling & enforcement

These are not optional; CI (`.github/workflows/ci.yml`) and the pre-commit hook
enforce them.

| Concern        | Tool                          | Command                  |
| -------------- | ----------------------------- | ------------------------ |
| Format + lint  | **Biome** (`biome.json`)      | `npm run lint` / `lint:fix` |
| Type checking  | **TypeScript** (`tsc --noEmit`) | `npx tsc --noEmit`     |
| Unit tests     | **Vitest** (jsdom)            | `npm run test`           |
| Browser tests  | **Vitest** (real Chromium)    | `npm run test:browser`   |
| E2E            | **Playwright**                | `npm run test:e2e`       |
| Build          | Vite + electron-builder       | `npx vite build`         |

- **Pre-commit**: Husky runs `lint-staged`, which runs `biome check` on staged
  `*.{ts,tsx,js,jsx,mts,cts,json}` files. Do not bypass with `--no-verify`.
- **CI gates on PRs to `main`**: lint, typecheck, unit + browser tests, and build
  must all pass.
- Node version is pinned (`.nvmrc`, `engines` in `package.json` → Node 22.x, npm
  10.x). Use it.

### Formatting (Biome) — the non-negotiables

From `biome.json` and `.editorconfig`:

- **Tabs for indentation** (not spaces). JSON/YAML use 2-space indent.
- **Double quotes** for strings (`"foo"`, never `'foo'`).
- **Line width 100**, line endings `lf`, trailing whitespace trimmed, final
  newline inserted.
- **Imports are auto-organized** (`assist.organizeImports: on`). Don't hand-sort;
  let Biome do it.
- `noExplicitAny` is a **warning** — avoid `any`; prefer `unknown` + narrowing.
- `noUnusedVariables` / `noUnusedImports` are **errors**. `tsconfig` also sets
  `noUnusedLocals` and `noUnusedParameters`. Dead code will not compile.
- `useConst`, `noVar` enforced. `useExhaustiveDependencies` is a **warning** for
  React hook deps — keep dependency arrays correct.

### TypeScript config (`tsconfig.json`)

- `strict: true`, `noFallthroughCasesInSwitch: true`. Write null-safe code.
- **Path alias `@/*` → `src/*`.** Always prefer `@/...` over deep relative paths
  from renderer code. (`electron/` code uses relative imports — it is a separate
  compilation surface and is not covered by the alias.)
- `allowImportingTsExtensions` + `isolatedModules` are on; `moduleResolution:
  bundler`. Module syntax must be import/export ESM (`"type": "module"`).

---

## 2. Project structure

```
src/                       # Renderer (React) — uses @/ alias
  components/
    ui/                    # shadcn/ui primitives (kebab-case files)
    launch/                # Launch/recording window feature
    video-editor/          # The editor feature (largest area)
      timeline/            # Timeline sub-feature
      videoPlayback/       # Rendering math/utilities (zoom, cursor, layout)
      types.ts             # Editor domain types
      editorDefaults.ts    # Default values / constants
      index.ts             # Barrel export
  contexts/                # React context (i18n, shortcuts only)
  hooks/                   # Custom hooks (use* prefix)
  lib/                     # Core logic: exporter/, captioning/, cursor/
  native/                  # Renderer-side native-bridge client + contracts
  utils/                   # Cross-cutting helpers
  i18n/                    # Custom i18n (config, loader, locales/)
  assets/                  # Static assets (cursors, etc.)

electron/                  # Main process + preload — relative imports
  main.ts, windows.ts, preload.ts
  ipc/                     # IPC handlers (legacy) + native bridge transport
  native-bridge/           # store, services/, cursor/ adapters + recording sessions
  native/                  # Native helper sources (Swift/C++) + prebuilt bin/
  recording/

docs/                      # This guide lives here, alongside architecture/, tests/
scripts/                   # Build + native test scripts (.mjs)
tests/                     # e2e/ (Playwright) + fixtures/
```

**Feature-folder organization.** A feature owns its components, its `types.ts`,
its defaults/constants, and sub-feature folders. The `video-editor` feature is the
template: PascalCase components at the top, camelCase utility modules alongside,
and a barrel `index.ts`.

---

## 3. Naming conventions

| Thing                              | Convention            | Example                          |
| ---------------------------------- | --------------------- | -------------------------------- |
| React component file               | `PascalCase.tsx`      | `VideoEditor.tsx`, `SettingsPanel.tsx` |
| shadcn/ui component file           | `kebab-case.tsx`      | `dropdown-menu.tsx`, `button.tsx` |
| Utility / logic module             | `camelCase.ts`        | `videoExporter.ts`, `compositeLayout.ts` |
| Type-only module                   | `camelCase.types.ts` or `types.ts` | `windowsNativeRecordingSession.types.ts` |
| Hook                               | `useXxx.ts`           | `useEditorHistory.ts`            |
| Electron main module               | `camelCase.ts` / `kebab` | `nativeBridge.ts`, `webm-duration.ts` |
| React component                    | `PascalCase`          | `function VideoEditor()`         |
| Function / variable                | `camelCase`           | `computeFrameStepTime`           |
| Props interface                    | `XxxProps`            | `interface SettingsPanelProps`   |
| True constant (number/string/regex)| `UPPER_SNAKE_CASE`    | `ENCODER_STALL_TIMEOUT_MS`, `DEFAULT_WALLPAPER` |
| Preset/lookup map constant         | `UPPER_SNAKE_CASE`    | `ZOOM_DEPTH_SCALES`, `GIF_SIZE_PRESETS` |
| IPC channel (legacy)               | `kebab-case` verbs    | `get-sources`, `request-camera-access` |
| Native-bridge action               | `camelCase`           | `saveProjectFile`, `getTelemetry` |

- **Function names start with a verb**: `get*` (lookup), `compute*` (calculate),
  `resolve*` (decide from context), `build*` / `create*`, `parse*`, `render*`.
- **Numeric literals use underscore separators**: `15_000`, `128_000`.
- **Defaults are prefixed `DEFAULT_`**; epsilons/tolerances get named constants
  (`SOURCE_COPY_EPSILON = 0.0001`), never inline magic numbers.

---

## 4. TypeScript conventions

- **`interface` for object shapes** (props, configs, contracts that may extend);
  **`type` for unions, aliases, and computed types**.
  ```ts
  export interface ExportConfig { /* ... */ }
  export type ExportFormat = "mp4" | "gif";
  export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;
  ```
- **No `enum`s.** Use union string/number literals exclusively.
- **Avoid `any`** (Biome warns). Use `unknown` and narrow with type guards. `lib/`
  has effectively zero `any`.
- **`as const`** for literal arrays/tuples that back a derived type:
  ```ts
  export const ASPECT_RATIOS = [/* ... */] as const;
  export type AspectRatio = (typeof ASPECT_RATIOS)[number];
  ```
- **`readonly`** on exported constant arrays and on injected constructor deps.
- **`satisfies`** is used in the native bridge for type-checked literals; prefer it
  over casts when you want inference plus checking.
- **Type-only imports** use `import type` (or inline `import { type X }`):
  ```ts
  import type { Span } from "dnd-timeline";
  import { type CSSProperties, useState } from "react";
  ```
- **Domain types are co-located** in a `types.ts` within the owning module
  (`src/lib/exporter/types.ts`, `src/components/video-editor/types.ts`). There is
  no single global types file.

---

## 5. React / renderer conventions

- **Function declarations for components**, not arrow consts:
  `export function LaunchWindow() { ... }`.
- **Exports**: feature components are commonly `export default function`; smaller
  shared pieces are named exports. shadcn/ui files export named composed parts.
  Follow the neighbor file.
- **Props** are typed with an `interface XxxProps` declared immediately above the
  component. shadcn components extend native element prop types +
  `VariantProps<typeof xxxVariants>`.
- **Hooks** live in `src/hooks/`, always `use`-prefixed. Heavy, deliberate use of
  `useCallback`/`useMemo` for handlers and derived values; `useRef` for DOM refs
  and cross-render mutable values. Keep `useEffect` dependency arrays exhaustive.
- **Large components are accepted.** `VideoEditor.tsx` (~3k lines) and
  `SettingsPanel.tsx` (~2k lines) co-locate related logic rather than fragmenting.
  Don't split a component purely for line count; do extract pure logic into
  sibling `*.ts` utility modules (the `videoPlayback/` folder is the pattern).

### State management

- **No Redux/Zustand/MobX.** State is React state + custom hooks; **Context is
  reserved for cross-cutting concerns only** (`I18nContext`, `ShortcutsContext`).
- **Feature state is prop-drilled** deliberately (e.g. `VideoEditor` owns editor
  state and passes it into `SettingsPanel`). This is intentional — don't introduce
  a store to avoid drilling.
- **Editor undo/redo** is a custom `useEditorHistory` hook with a
  past/present/future `History` shape. Undoable state (zoom/trim/speed/annotation
  regions, crop, styling) lives in `EditorState`; transient UI/selection state is
  kept out of history.

### Styling

- **Tailwind, utility-first.** Always compose classes through the `cn()` helper
  (`src/lib/utils.ts` = `clsx` + `tailwind-merge`), never bare template strings
  when conditionals are involved.
  ```tsx
  className={cn("flex h-8 w-8 items-center justify-center rounded-lg border",
    isActive ? "border-[#34B27B]/50 bg-[#34B27B]/15" : "border-transparent")}
  ```
- **Variants via `cva`**: define `xxxVariants = cva(base, { variants, defaultVariants })`
  and derive prop types with `VariantProps`. This is the standard for `ui/`.
- **Custom values** via bracket notation (`bg-[#09090b]`, `shadow-[...]`) are fine.
- **CSS is minimal**: `index.css`/`App.css` globals, plus the occasional CSS module
  for Electron-specific needs (e.g. window drag regions in
  `LaunchWindow.module.css`). Biome ignores `*.css`.

### UI primitives (shadcn/ui + Radix)

- Components in `src/components/ui/` wrap Radix primitives: import the primitive,
  style with `cn()`, re-export the composed parts. Configured via `components.json`
  (style: new-york, RSC off, `@/components`, `@/lib/utils`).
- Use **`React.forwardRef`** and set `displayName` on forwarded components, mirroring
  the existing files. Add new primitives by following an existing one (e.g.
  `dialog.tsx`) closely rather than improvising structure.

---

## 6. Electron / IPC conventions

> Full design rationale: [`docs/architecture/native-bridge.md`](architecture/native-bridge.md).

### Process split & security

- **`contextIsolation: true`, `nodeIntegration: false`** on every window. Do not
  weaken this. (`webSecurity: false` exists only on the editor window for local
  file loading — don't copy it elsewhere.)
- The **preload exposes a single `window.electronAPI`** via `contextBridge`; the
  renderer never touches Node/Electron directly.
- Windows are differentiated by a `?windowType=` query param
  (`hud-overlay`, `editor`, `source-selector`, `countdown-overlay`) and created
  through wrapper factories in `windows.ts` / `main.ts`.

### Two IPC styles — prefer the new one

1. **Legacy individual channels** (`electron/ipc/handlers.ts`): `ipcMain.handle("kebab-case-name", ...)`,
   returning a flat result envelope `{ success: boolean; error?: string; canceled?: boolean; ...data }`.
   Hundreds of these exist; maintain their style when editing them.
2. **Unified native bridge** (preferred for new native-facing features): a single
   `native-bridge:invoke` channel taking `{ domain, action, payload, requestId }`
   and returning a typed envelope:
   ```ts
   // success
   { ok: true,  data: TData, meta: { version, requestId, timestampMs } }
   // failure
   { ok: false, error: { code, message, retryable }, meta }
   ```
   Error codes are a fixed union: `INVALID_REQUEST | UNSUPPORTED_ACTION |
   NOT_FOUND | UNAVAILABLE | INTERNAL_ERROR`.

- **Contracts are shared** in `src/native/contracts.ts` (discriminated union of
  request shapes). The renderer calls through `src/native/client.ts`
  (`nativeBridgeClient.system/project/cursor.*`), not raw IPC. `requireNativeBridgeData<T>()`
  unwraps `ok`/throws.
- **New native features go through the bridge**, not new ad-hoc `electronAPI`
  channels.

### Native-bridge layering

`adapter (platform) → service (orchestration + state) → transport (single IPC handler) → client (renderer facade)`

- **Services** are classes with `constructor(private readonly options: T)`
  dependency injection; they own state via the `NativeBridgeStateStore`
  (immutable spread updates).
- **Platform dispatch** is via a `factory.ts` switching on `process.platform`
  (`win32` → WGC session, `darwin` → ScreenCaptureKit session, else telemetry-only
  fallback). Interface + per-platform implementation is the standard shape
  (`session.ts` interface, `mac*/windows*/telemetry*Session.ts`).
- **Native helpers** (Swift `screencapturekit/`, C++ `wgc-capture/`) are spawned as
  child processes communicating via **newline-delimited JSON** on stdio; control
  commands go over stdin (`pause\n`, `resume\n`, `stop\n`). Binaries are resolved
  by a candidate list: **env override → local build → packaged `bin/<arch>` →
  resources** (handling `.asar` unpacking on Windows). Prebuilt binaries live in
  `electron/native/bin/<platform-arch>/`.

---

## 7. Core logic (`src/lib`) conventions

- **Classes for stateful pipelines** (`VideoExporter`, `FrameRenderer`,
  `AudioProcessor`, `VideoMuxer`); **pure functions for transforms/computations**
  (`computeCompositeLayout`, `getSmoothedCursorPath`, `parseCssGradient`).
- **One module = one responsibility**, even if that means 700–1100 line files.
- **`async/await` only** — no raw `.then()` chains.
- **Cancellation via boolean flags** (`private cancelled = false`) checked in
  loops, with cleanup in `finally`. `AbortController` is **not** used in lib code;
  stay consistent unless there's a strong reason.
- **`Promise.all`** for parallel finalization; a custom `withTimeout` wrapper for
  stall protection rather than ad-hoc `Promise.race`.

### Error handling

- **Result objects** (`{ success, error, warnings? }`) for *expected* failure modes
  (export results, IPC responses).
- **Custom `Error` subclasses** for domain failures, with `cause` chaining
  (`BackgroundLoadError`).
- **Throw only for programmer errors / unrecoverable state** ("Muxer not
  initialized").
- **Early-return `null`** for missing/invalid inputs in pure functions.

### Logging

- **No logger abstraction** — direct `console.*`.
- **Always prefix with a component tag**: `console.warn("[VideoExporter] ...")`,
  `console.info("[native-wgc] ...", { structuredData })`.
- `console.warn` for recoverable/fallback, `console.error` for failures in
  callbacks/async, `console.info`/`console.log` for milestones (sparingly).

---

## 8. Internationalization

- **Custom lightweight i18n** (no i18next/react-intl). Keys are dot-notation,
  namespaced: `namespace.category.key`; interpolation uses `{{var}}`.
- **Locales = one JSON file per namespace per locale** under
  `src/i18n/locales/<locale>/<namespace>.json`. Namespaces: `common`, `dialogs`,
  `editor`, `launch`, `settings`, `shortcuts`, `timeline`. `en` is the baseline.
- **Components translate via hooks** (`src/contexts/I18nContext.tsx`):
  ```tsx
  const t = useScopedT("launch");      // scoped to one namespace (most common)
  t("audio.defaultMicrophone");
  t("dialogs.export.yourFormatReady", { format: "MP4" });  // with vars
  ```
  Use `useI18n()` for `locale`/`setLocale` or fully-qualified keys.
- **The Electron main process has its own minimal copy** (`electron/i18n.ts`,
  `mainT(...)`) for menus/dialogs — keep it in sync when adding main-process UI
  strings.
- **Any user-facing string must be added to all locales.** `npm run i18n:check`
  enforces key parity (missing/extra keys, missing files) against `en`. ⚠️ It is
  **not yet wired into CI or pre-commit** — run it manually before adding strings.
  (Wiring it into CI is a recommended improvement.)

---

## 9. Testing

> Full guide: [`docs/tests/writing-tests.md`](tests/writing-tests.md).

- **Three tiers:**
  - **Unit** (`*.test.ts[x]`, jsdom): pure logic, hooks, components with mocked
    deps, IPC handler logic. Most code.
  - **Browser** (`*.browser.test.ts`, real Chromium): anything needing real Web
    APIs — WebCodecs, `MediaRecorder`, `OffscreenCanvas`, WebGL, Pixi, real Blob
    export.
  - **E2E** (`tests/e2e/*.spec.ts`, Playwright): full Electron flows.
- **Placement: co-locate the test next to the source** (`foo.ts` → `foo.test.ts`).
  A `__tests__/` folder is used only for cross-module/grouped tests.
- **Style:** `describe("subject", ...)` + `it("present-tense behavior", ...)` —
  describe behavior, **not** "should...". Vitest `expect` + `@testing-library/jest-dom`
  matchers. `toBeCloseTo` for floats.
- **Mocking:** `vi.mock`/`vi.fn`; mock `useScopedT` to identity, mock
  `window.electronAPI` methods, override `navigator.mediaDevices`. No snapshot
  testing.
- **Fixtures** (real media) live in `tests/fixtures/`, imported in browser tests
  with Vite's `?url` suffix.
- **fast-check is a dependency but currently unused** — tests are deterministic
  with hand-crafted edge cases.
- **Coverage reality:** core logic (export pipeline, layout math, cursor smoothing,
  preferences, i18n) is well tested; **UI components are largely untested**. New
  pure logic should ship with tests; new UI at least needs a smoke test where
  practical.

---

## 10. Git & contribution workflow

- **Branch** off `main`: `feature/...` or `fix/...`. `main` is the PR base.
- **One owner** (`.github/CODEOWNERS` → `@siddharthvaddem`); this is a fork, adjust
  as needed for your workflow.
- **PRs** follow `.github/pull_request_template.md`: description, motivation, type,
  linked issues, screenshots/video for UI changes, testing notes, self-review
  checklist.
- **Before pushing**, locally green: `npm run lint`, `npx tsc --noEmit`,
  `npm run test` (and `npm run test:browser` if you touched export/render code),
  plus `npm run i18n:check` if you touched strings.
- Commit messages: clear and descriptive (per `CONTRIBUTING.md`). No enforced
  conventional-commits format.

---

## Quick checklist for new code

- [ ] Tabs, double quotes, ≤100 cols — or just run `npm run lint:fix`.
- [ ] Imports via `@/` (renderer); let Biome organize them.
- [ ] `interface` for shapes, `type` for unions; no `enum`; no `any`.
- [ ] Components: `function` decl + `XxxProps` interface; style via `cn()`/`cva`.
- [ ] New native feature → native bridge (`contracts.ts` + `client.ts`), not a new
      `electronAPI` channel.
- [ ] User-facing strings → all locale files; `npm run i18n:check` clean.
- [ ] Pure logic → co-located `*.test.ts`; real-Web-API code → `*.browser.test.ts`.
- [ ] `console.*` tagged with `[Component]`.
- [ ] `npm run lint && npx tsc --noEmit && npm run test` green before PR.
