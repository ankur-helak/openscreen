# CLAUDE.md — `src/` (renderer / React)

> **Maintenance:** Keep this file current. When you change this folder's structure, commands,
> conventions, or the architecture described here, update this file in the same change.

This is the **React renderer**. The authoritative conventions guide is
[`../docs/coding-style.md`](../docs/coding-style.md) — read it; this file is a quick orientation.

## Essentials

- **Always import via the `@/` alias** (`@/...` → `src/...`); never deep relative paths. (The
  alias is renderer-only — `electron/` uses relative imports.)
- **One renderer bundle, multiple windows.** `App.tsx` reads a `?windowType=` query param
  (`hud-overlay`, `source-selector`, `countdown-overlay`, default `editor`) and renders the
  matching surface.

## Layout

- `components/` — feature folders. `video-editor/` is the largest feature: `VideoEditor.tsx`
  owns editor state and **prop-drills** it into panels (intentional — no Redux/Zustand). Undo/redo
  is the custom `hooks/useEditorHistory` hook. Pure rendering math lives in
  `video-editor/videoPlayback/`. `VoiceoverPanel` is the project-wide `"voiceover"` mode in
  `SettingsPanel`'s nav rail (per-segment edit/audition via `VoiceoverSegmentRow`);
  `video-editor/timeline/` includes a read-only `VoiceoverRow`. `components/ui/` holds shadcn/ui
  primitives (kebab-case files).
- `contexts/` — Context is reserved for cross-cutting concerns only (`I18nContext`,
  `ShortcutsContext`); don't add a store to avoid prop-drilling.
- `lib/` — the core engine: `exporter/` (MP4/GIF pipeline via WebCodecs / `pixi.js` /
  `mediabunny` / `mp4box`; includes voiceover replace-mode audio path via
  `synthesizeVoiceoverTrack`), `captioning/` (on-device `@xenova/transformers` in a worker — see the
  Vite stubs in `lib/vite-stubs/`), `transcription/` (provider-abstracted transcript generation
  wrapping `captioning/`; Whisper default, cached per-video via the native bridge), `cursor/`,
  `voiceover/` (`layoutVoiceover` output-time alignment consumed by preview + export; shared
  `bed.ts` mono-bed builder; `captionsFromScript` projects script→caption regions anchored at source
  time, consumed via `computeEffectiveAnnotationRegions` to link captions to voiceover), `script/`
  (OpenAI script-polish pure helpers: budget math, tone presets, response validation). Classes for
  stateful pipelines, pure functions for transforms.
- `native/` — the renderer **facade for the native bridge** (`client.ts`, `contracts.ts`). Call
  through `nativeBridgeClient.*` (includes `nativeBridgeClient.transcript.*` for transcript cache +
  caption drafts), not raw IPC.
- `hooks/` (`useXxx`, including `useTranscript` for auto-generating + caching transcripts on video
  load, `useClipAudition` for standalone single-clip audition, `useVoiceoverPlayback` for
  timeline-synced voiceover preview), `utils/`, `i18n/`, `assets/`. Editor state includes a
  `captions` slice (global style, position, size, min/max words per caption) used when voiceover is
  enabled.

## Conventions worth remembering

- `interface` for object shapes, `type` for unions; **no `enum`**, avoid `any`.
- Components: `function` declarations + an `XxxProps` interface; style with `cn()` + `cva`
  (Tailwind, utility-first).
- **i18n**: translate via `useScopedT(namespace)` / `useI18n()`. Any user-facing string must be
  added to **all** locale files under `i18n/locales/`, then verified with `npm run i18n:check`.
- Tests co-located (`foo.ts` → `foo.test.ts`); real-Web-API code uses `*.browser.test.ts`. See
  [`../docs/tests/writing-tests.md`](../docs/tests/writing-tests.md).
