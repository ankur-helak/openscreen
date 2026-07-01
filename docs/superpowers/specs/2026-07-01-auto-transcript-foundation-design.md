# Auto-Transcript Foundation — Design

**Date:** 2026-07-01
**Status:** Approved (design)
**Scope:** Foundation only. AI voiceover is a separate, later cycle that builds on this.

## Overview

Today the app only produces a transcript when the user clicks **Auto captions**, and it
immediately converts the result into caption overlay regions and discards the raw transcript.
This cycle makes the app **generate a transcript automatically and silently whenever a video is
loaded**, **cache it** so the same video is never re-transcribed, and **store it** so it is always
available — even if the user never opens Auto captions. The transcript becomes the source of
truth for a future AI-voiceover feature.

Transcription work is modular and the model is configurable (Whisper is the default), so a
different offline model or an API-based model can be dropped in later without touching callers.

## Goals

- Automatically generate a transcript on video load, in the background, without showing it in the UI.
- Persist the transcript so it survives across sessions and is ready for downstream use (voiceover).
- Never re-transcribe the same video (cache keyed to the video).
- Keep the transcript (raw source) and captions (editable overlays) as separate concerns that
  never overwrite each other.
- Preserve caption edits before an explicit project save (local autosave).
- Make the transcription provider/model modular and configurable, with Whisper as the default.

## Non-Goals (explicitly out of scope this cycle)

- AI voiceover / text-to-speech (next cycle; will read the transcript cache produced here).
- A settings-UI selector for choosing the model/provider (architecture supports it; UI deferred).
- A concrete API-model provider implementation (interface only).
- Embedding the raw transcript inside the project file (voiceover reads the sidecar cache).
- Multi-language selection.

## Background — current state (verified)

- Engine lives in `src/lib/captioning/`:
  - `extractMono16kFromVideoUrl()` (audio extraction, browser APIs).
  - `transcribeMono16kToSegments()` → `{ segments: CaptionSegment[]; granularity }`, where
    `CaptionSegment = { startSec: number; endSec: number; text: string }` (`transcribe.ts`).
  - Whisper runs in a Web Worker (`transcribe.worker.ts`) via `@xenova/transformers`; default
    model **`Xenova/whisper-tiny`** (hardcoded in the worker and in `scripts/fetch-caption-model.mjs`).
  - `captionSegmentsToAnnotationRegions()` converts segments into caption overlay regions.
- The only trigger is `generateAutoCaptions()` in `src/components/video-editor/VideoEditor.tsx`
  (~line 2207). It extracts → transcribes → converts to regions → `pushState`. The raw transcript
  is transient.
- The video-load hook point is the editor's load effect (`VideoEditor.tsx` ~540–602), which sets
  `videoPath` for all three entry paths (recording handoff session, `getCurrentVideoPath()`,
  loaded project).
- Persistence: the project file stores `annotationRegions` (`projectPersistence.ts`) via the
  native-bridge `project` service (`nativeBridgeClient.project.saveProjectFile`). No transcript is
  stored anywhere; there is no SRT/VTT/text export.
- **Model packaging:** in packaged builds the model is already bundled and shipped via
  electron-builder `extraResources` (`caption-assets/`, populated by `scripts/fetch-caption-model.mjs`)
  and loaded offline from disk (`transcribe.worker.ts`: `env.allowRemoteModels = false`,
  `env.localModelPath`). In dev it is fetched from the HuggingFace CDN and cached by
  transformers.js in the browser Cache API. So there is **no runtime download for the default
  model in the shipped app**.
- `MAX_CAPTION_AUDIO_SEC` is 4 hours, so transcript truncation is a non-issue for real videos.

## Key decisions

1. **Foundation first.** Voiceover is a later cycle.
2. **Transcript vs captions are separate.** Transcript = raw generated speech-to-text (source of
   truth). Captions = editable overlays derived from it (shown only after Auto captions).
3. **Auto-generate silently on load**, store, do not surface in UI this cycle.
4. **Default model stays bundled** (whisper-tiny) → transcription "just works" offline with no
   download. A generic download-with-progress flow exists but only activates for a model that is
   *not already on disk* (future non-bundled/API model).
5. **Architecture: renderer-orchestrated, main-process persistence** (Approach 1). Whisper
   inference must run in the renderer (transformers.js + WebCodecs are browser-only). The provider
   interface is written so it does not assume renderer-only, so an API/main-process provider is a
   clean later extension.
6. **Persistence (split responsibilities):**
   - Transcript → sidecar cache in `userData`, keyed to the video.
   - Edited captions → project file (portability) **and** local autosave drafts in `userData`.
   - Load priority: saved project captions → autosave draft → transcript cache → generate.
   - The transcript cache never overwrites edited captions.
7. **Auto captions reuses the stored transcript** (instant), generating only if none is cached.
8. **Provider/model is modular and configurable now**; the settings-UI selector is deferred.
9. **Paths:** bundled model resolves via `resourcesPath`; any *downloaded* model writes to
   `app.getPath('userData')` and is referenced by an absolute path resolved at runtime (no
   repo-relative paths, which break in packaged builds).

## Architecture

### Module layout

- `src/lib/captioning/` (existing) remains the engine: audio extraction, the Whisper worker, and
  `captionSegmentsToAnnotationRegions`. Largely untouched.
- `src/lib/transcription/` (new) — orchestration + abstraction:
  - `types.ts` — `Transcript`, `TranscriptStatus`, `TranscriptionProvider`.
  - `providers/whisperLocal.ts` — implements `TranscriptionProvider` by wrapping the existing
    `extractMono16kFromVideoUrl` + `transcribeMono16kToSegments`.
  - `config.ts` — provider/model registry, default (`whisper-tiny`), `getActiveProvider()` factory.
    Config is a constant now (env/settings later).
  - `loadPlan.ts` — pure function `resolveTranscriptLoadPlan(inputs)` deciding what to do on load.
  - `index.ts` — barrel.

### Data model

```ts
interface Transcript {
  segments: CaptionSegment[];        // reuse existing {startSec,endSec,text}
  granularity: "word" | "phrase";
  provider: string;                  // "whisper-local"
  model: string;                     // "whisper-tiny"
  audioDurationSec: number;
  createdAt: number;
  schemaVersion: number;             // for cache migration
}

type TranscriptStatus =
  | { state: "idle" }
  | { state: "preparing-model" }
  | { state: "transcribing" }
  | { state: "ready"; transcript: Transcript }
  | { state: "no-speech" }
  | { state: "no-audio" }
  | { state: "error"; message: string };
```

### Provider interface

```ts
interface TranscriptionProvider {
  id: string;
  model: string;
  isModelAvailable(): Promise<boolean>;                        // gates the download flow
  ensureModel(onProgress?: (p: number) => void): Promise<void>; // no-op for bundled default
  transcribe(
    videoUrl: string,
    opts: { trimRegions?: TrimRegion[]; signal?: AbortSignal; onStatus?: (phase) => void },
  ): Promise<TranscribeMono16kResult>;
}
```

`WhisperLocalProvider.transcribe` internally does extract → worker (existing path).
`isModelAvailable`/`ensureModel` are effectively no-ops for the bundled default; they exist so a
future non-bundled model can trigger the download-with-progress flow.

## Persistence

Implemented as a new native-bridge service (following the existing `project` service pattern:
contracts in `src/native/contracts.ts` → client `src/native/client.ts` → transport
`electron/ipc/nativeBridge.ts` → service in `electron/native-bridge/services/`). Exact wiring is
finalized during planning.

Stores:

- **Transcript cache** — `userData/transcripts/<key>.json` holding a `Transcript`.
  Key = a stat signature of the video source (absolute path + byte size + `mtimeMs`) hashed to a
  filename-safe string. Cheap (no full-file hashing). Cache also records `no-speech`/`no-audio`
  outcomes so those videos are not re-run on every load.
- **Caption autosave drafts** — `userData/caption-drafts/<key>.json` holding the caption
  annotation regions (`annotationSource === "auto-caption"`). Written debounced on caption edits;
  cleared after a successful project save.
- **Project file** — edited captions persist as today (`annotationRegions`). The raw transcript is
  not embedded here this cycle.

### Load priority (pure `resolveTranscriptLoadPlan`)

On editor video load:

1. **Captions to display:** saved project captions (already loaded via the project) → else
   autosave draft for this video → else none (until the user clicks Auto captions).
2. **Transcript (always, silent):** transcript cache hit → load into memory (`ready`) → else run
   the provider, then write to cache.

Invariant: regenerating/refreshing the transcript writes only to the transcript cache and never
mutates caption regions. Auto captions deriving overlays from a transcript must not clobber
existing edited caption regions.

## Orchestration — `useTranscript` hook

New hook under `src/components/video-editor/hooks/` (matching existing hook conventions, e.g.
`useEditorHistory`):

- Runs on `videoPath` change: compute video key (via the main-process service, from the source
  path stat) → check transcript cache → on miss set `preparing-model`/`transcribing`,
  `ensureModel(onProgress)` then `transcribe` silently, then store to cache and set `ready`
  (or `no-speech`/`no-audio`/`error`).
- Single in-flight transcription per video (ref-guard); aborts on video change/unload via the
  existing AbortSignal path (worker termination).
- Exposes `transcriptStatus`, `transcript`, and `regenerate()`.

`generateAutoCaptions()` (`VideoEditor.tsx` ~2207) is refactored to:

- Await the hook's transcript (reusing the cache or the in-flight run — no re-transcription).
- Convert to regions via the existing `captionSegmentsToAnnotationRegions`, then `pushState`.
- Surface `no-speech`/`no-audio`/`error` using the existing toasts
  (`autoCaptions.noneHeard` / `autoCaptions.noAudio` / `autoCaptions.failed`) — instantly from the
  cached status. No new i18n strings required.

## Model-download UX

The `preparing-model` status drives a small, non-blocking toast ("Preparing transcription
model…"). For the bundled default this never fires; it is plumbing for a future non-bundled/API
model. The worker gains a `progress` message (0..1) so a percentage can be shown later. No
blocking modal (YAGNI).

## Error handling / edge cases

- Silent transcription failure, no-speech, or no-audio during background generation: store the
  status, show **no unprompted toast**. These are surfaced only when the user clicks Auto captions
  (as today). `error` is retried on next load; cached `no-speech`/`no-audio` are not re-run.
- Existing short-audio guards (`durationSec <= 0`, `< 800` samples) are preserved.
- Cache invalidates automatically when the video's stat signature changes.
- Concurrency: one in-flight transcription per video; Auto captions reuses it.
- Autosave: debounced writes of caption regions on edit; superseded/cleared after a successful
  project save.

## Testing (three tiers per `docs/tests/writing-tests.md`)

- **Unit (jsdom):**
  - `resolveTranscriptLoadPlan` across all priority permutations (project captions / draft / cache
    / none).
  - Transcript cache-key computation.
  - Provider/config factory selection (default = whisper-tiny).
  - Persistence services with mocked `fs`.
- **Browser tier:** rely on existing captioning coverage; optionally one short-sample provider
  smoke test.
- **No new E2E** (the model is too heavy).

## File-level change summary (indicative; finalized in the plan)

- New: `src/lib/transcription/{types,config,loadPlan,index}.ts`,
  `src/lib/transcription/providers/whisperLocal.ts`.
- New: `src/components/video-editor/hooks/useTranscript.ts`.
- New: native-bridge transcript/caption-draft service (contracts + client + transport + service).
- Modified: `src/components/video-editor/VideoEditor.tsx` (wire `useTranscript` into the load
  effect; refactor `generateAutoCaptions` to reuse the stored transcript; autosave caption edits).
- Possibly modified: `src/lib/captioning/transcribe.worker.ts` + `transcribe.ts` (add a `progress`
  message for the download flow).
- Tests co-located with the above.
