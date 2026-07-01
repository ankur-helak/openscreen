# AI Voiceover (Replace Narration) — Design Spec

- **Date:** 2026-07-01
- **Status:** Approved for planning (pending final spec review)
- **Branch context:** builds on `feat/auto-transcript-foundation` (persisted transcript foundation)
- **Feature area:** `src/lib/tts/`, `src/lib/voiceover/`, video editor, export pipeline, native bridge

## 1. Summary

Add an **AI Voiceover** feature that lets a user replace the original spoken narration in a screen recording with a clean, synthesized voice. The user's recording is auto-transcribed (already implemented and now persisted); we turn that transcript into an **editable script**, synthesize speech per segment with an **on-device TTS engine (Kokoro)**, anchor each generated clip to the video timeline, mute the original audio, and mix the synthesized track into preview and export.

This is the "replace my narration" workflow (à la Trupeer / Descript): record naturally, fix the words as text, get a broadcast-quality voice — without re-recording.

## 2. Motivation

The team just made the speech-to-transcript output **persist**. That work is the enabling foundation for TTS, because the transcript is the bridge:

1. The transcript provides an **editable script** — the words the user actually said.
2. The transcript provides **per-segment timing** (`startSec`/`endSec`), which lets a newly synthesized voice be placed back on the timeline aligned to the original recording.
3. The persisted transcript is the durable source-of-truth text the voiceover reads from.

The strategic payoff: a user records a rough screencast, cleans up the text, and replaces their mumbled narration with a professional AI voice — the highest-value use of the transcript work.

## 3. Market context (why this shape)

- **Trupeer** (direct competitor): record → auto-script from transcript → pick a voice → studio-quality AI voiceover; 120+ languages; avatars. Recording's transcript becomes an editable script that drives narration.
- **Descript**: text-based editing; Overdub (voice clone) + stock AI voices; "Regenerate" to repair edits. Speech is tied to editing text.
- **Cloud TTS**: ElevenLabs (best quality, voice cloning, character-level timestamps, ~$0.17–0.20/1k chars, API key); OpenAI `gpt-4o-mini-tts` (13 voices, `instructions` for tone/speed, wav/pcm @24 kHz, no word timestamps).
- **On-device TTS**: **Kokoro-82M** via `kokoro-js` (`transformers.js`/ONNX — the same stack the existing Whisper captioning worker uses). Apache-2.0, runs 100% locally in-browser (WebGPU or WASM), q8 ≈ 92 MB, 24 kHz output, ~28 voices, streaming supported. This is the architectural twin of the existing captioning worker: no API keys, no per-character cost, offline, private.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Use case | **Replace narration** (transcript → editable script → AI voice, anchored) | Highest strategic value; leverages persisted transcript |
| Engine | **On-device Kokoro first**, cloud opt-in later, behind a `TtsProvider` seam | Zero-config, offline, private; mirrors Whisper setup |
| Alignment | **Anchor per segment**, video untouched, natural length, nudge overlaps | Preserves existing timeline/export model; only ADD audio |
| Original audio | **Always fully muted** (output audio synthesized from clips) | Simplest; mic+system are pre-mixed so can't isolate voice |
| AI script polish | **Deferred** to a later phase (per-segment, provider seam) | Doesn't fit on-device cleanly; keeps v1 shippable/offline |
| Voice scope | **Single project-wide voice + speed** | Covers common case; per-segment override deferred |
| Generation | **Explicit** ("Generate all" / per-segment), with caching | Intentional; avoids surprise CPU/model spin-up |
| Architecture | **Mirror the transcript/captioning layering** | Team familiarity; clean layering; cloud seam |

## 5. Goals / Non-goals

### Goals (v1)
- On-device Kokoro TTS, bundled and offline, behind a `TtsProvider` interface.
- Derive an editable, sentence-segmented **voiceover script** from the persisted transcript.
- Manual per-segment script editing.
- Single project-wide voice + speed.
- Explicit generation (per-segment + "Generate all") with content-hash caching.
- Anchor-per-segment alignment via a single pure `layoutVoiceover` function, shared by preview and export.
- Preview playback (original muted, synthesized clips scheduled via Web Audio).
- Export: synthesize the full output audio track from clips (original muted), encode + mux.
- English (Kokoro American/British voices).

### Non-goals (future phases)
- Cloud TTS providers (ElevenLabs / OpenAI) and voice cloning.
- AI "polish the script" pass (per-segment, provider seam).
- Multi-language / dubbing / translation.
- Per-segment voice overrides.
- Manual merge/split of voiceover segments; drag-to-reposition clips on the timeline.
- Video retiming ("video follows the words").
- Ducking / keep-original-audio volume control.
- AI avatars.
- Caption↔script synchronization.

## 6. Architecture overview

```
raw transcript (immutable, already cached in userData/transcripts/<hash>.json)
        │  seed (copy) — sentence segmentation
        ▼
Voiceover Script  ── manual per-segment edit ──┐
 (editable, saved in project JSON)             │
        │  per-segment TTS (Kokoro Web Worker)  │
        ▼                                       │
Generated clips (cached wav @24kHz, userData/voiceovers/<hash>.wav)
        │                                       │
        ▼                                       │
layoutVoiceover()  ← trimRegions + speedRegions + overlap ──┘   (pure, shared)
        │
        ├──► Preview: schedule clips via Web Audio; <video> muted
        └──► Export: synthesize full PCM track (source muted) → AudioEncoder → mux
```

Layering mirrors the native-bridge convention:
`adapter/provider (Kokoro worker) → engine (src/lib/tts) → feature (src/lib/voiceover + useVoiceover) → UI (panel/timeline) → persistence (native-bridge voiceover domain)`.

## 7. Data model

### 7.1 Undoable state (the script)

Added to `EditorState` in `src/hooks/useEditorHistory.ts` (and `INITIAL_EDITOR_STATE`), so script edits participate in undo/redo like other regions:

```ts
interface VoiceoverConfig {
  enabled: boolean;              // voiceover replaces original audio
  engine: "kokoro-local";       // provider id — the cloud seam
  voice: string;                // Kokoro voice id (project-wide), e.g. "af_heart"
  speed: number;                // 0.7–1.2, default 1.0
  segments: VoiceoverSegment[];
}

interface VoiceoverSegment {
  id: string;                   // "vo-<nid>"
  sourceStartMs: number;        // anchor, from transcript segment start
  sourceEndMs: number;          // original spoken span end (overlap/reference)
  text: string;                 // editable script line (seeded from transcript)
}
```

### 7.2 Runtime (non-undoable) state

Managed by a new `useVoiceover` hook (mirrors `useTranscript`), holding per-segment synthesis status and resolved audio buffers, keyed by segment id + content hash. Not part of undo/redo — same split already used (transcript status is runtime; captions are undoable).

```ts
type SegmentSynthStatus =
  | { state: "idle" }
  | { state: "queued" }
  | { state: "synthesizing" }
  | { state: "ready"; audioKey: string; durationMs: number }
  | { state: "error"; message: string };
```

`audioKey = sha1(text + voice + speed + engine + model)` — deterministic content hash; identical inputs reuse the cache.

## 8. Components & file map

### 8.1 TTS engine layer — `src/lib/tts/` (mirrors `src/lib/captioning/`)

- `provider.ts` — `TtsProvider` interface + shared types:
  ```ts
  interface TtsSynthesisResult { pcm: Float32Array; sampleRate: number; } // Kokoro: 24000, mono
  interface TtsProvider {
    id: string;
    listVoices(): Promise<Array<{ id: string; label: string; lang: string }>>;
    synthesize(text: string, opts: { voice: string; speed: number },
               signal?: AbortSignal): Promise<TtsSynthesisResult>;
  }
  ```
- `kokoroProvider.ts` — implements `TtsProvider`; spins up and talks to the worker.
- `synthesize.worker.ts` — runs `kokoro-js` (`KokoroTTS.from_pretrained`) with `dtype: "q8"`, `device: "wasm"`. In packaged builds, load the model from bundled assets (set `env.localModelPath` / `allowRemoteModels=false` / onnx wasm paths), exactly as the Whisper worker does. Message protocol mirrors `transcribe.worker.ts` (`{type:"status"} | {type:"result", pcm, sampleRate} | {type:"error"}`).

**Model assets:** bundle Kokoro q8 (~92 MB) + its ONNX runtime alongside the existing `caption-assets/`. Reuse the same packaging/asar-unpack + candidate-path resolution the caption models use. WebGPU/fp32 is a documented later performance upgrade, not v1.

### 8.2 Voiceover feature — `src/lib/voiceover/`

- `types.ts` — `VoiceoverConfig`, `VoiceoverSegment`, `SegmentSynthStatus` (or co-located with editor types; re-export as needed).
- `segmentation.ts` — `segmentTranscript(transcript): VoiceoverSegment[]`:
  - Group consecutive `CaptionSegment`s into **sentences**.
  - Primary split on sentence-ending punctuation (`. ! ?`).
  - Secondary split on inter-segment **silence gap** above a threshold (e.g. > 700 ms).
  - Cap max clip length (~20–30 s).
  - Anchor each unit at its first constituent's `startSec` → `sourceStartMs`; `sourceEndMs` = last constituent's `endSec`; `text` = concatenated segment text (trimmed).
- `layout.ts` — `layoutVoiceover(...)` (see §9), the pure alignment function.

### 8.3 Orchestration — `src/hooks/useVoiceover.ts`

Mirrors `useTranscript`. Responsibilities:
- Seed `segments` from the transcript when the script is empty (first time), via `segmentation.ts`.
- Drive synthesis on explicit request (`generateSegment(id)`, `generateAll()`): set status, call the provider, write result to cache (native bridge), resolve `audioKey` + `durationMs`.
- On load, resolve cached audio for existing segments (cache hit → ready; miss → idle, awaiting generation). Deterministic hashing means unchanged text/voice/speed reuse audio.
- Expose decoded `AudioBuffer`s (for preview) and `audioKey`s (for export layout).

### 8.4 UI — `src/components/video-editor/VoiceoverPanel.tsx` (+ timeline)

- **Panel** (prop-drilled from `VideoEditor.tsx`, like `SettingsPanel`):
  - Enable voiceover toggle; voice picker (from `listVoices()`); speed slider (0.7–1.2); "Generate all" button + aggregate progress.
  - Segment list: per row — editable text, anchor timestamp, status chip, ▶︎ preview, regenerate.
- **Timeline** (`timeline/TimelineEditor.tsx`): add a read-only "Voiceover" row rendering placed clips from `layoutVoiceover`. Clicking a clip selects/scrolls to its segment in the panel. Drag-to-reposition is out of scope for v1 (positions are auto from anchors).

### 8.5 Persistence — native-bridge `voiceover` domain (mirrors `transcript`)

- Contracts in `src/native/contracts.ts`: actions `getVoiceoverClip {key}`, `putVoiceoverClip {key, audio}`, (optional) `clearVoiceover`. Result types mirror `TranscriptCacheResult`.
- Service `electron/native-bridge/services/voiceoverService.ts`: read/write `userData/voiceovers/<key>.wav` via `fs/promises`. Keyed by **content hash** (text+voice+speed+engine+model), NOT by source file (voiceover audio is defined by what generates it).
- Client facade in `src/native/client.ts`: `nativeBridgeClient.voiceover.{getClip,putClip}`.
- Register the service in the native-bridge factory/store wiring.
- **Project JSON**: the `VoiceoverConfig` script is serialized into `ProjectEditorState` (`src/components/video-editor/projectPersistence.ts`). Bump `PROJECT_VERSION` (2 → 3) with a migration that defaults `voiceover` to a disabled empty config for older projects. Generated audio is NOT embedded in the project; it is re-derivable from the script via the content-hash cache (regenerated on demand if the cache is absent, e.g. on another machine).

### 8.6 Export — `src/lib/exporter/`

- `videoExporter.ts`: extend `VideoExporterConfig` with `voiceover?` (enabled + resolved placed clips, or the data needed to resolve them). When enabled with clips → **replace mode**:
  - Skip the source-audio decode/re-encode path entirely.
  - `AudioProcessor.synthesizeVoiceoverTrack(placedClips, outputDurationMs, codec, muxer)`: allocate a silent PCM buffer at export sample rate (e.g. 48 kHz stereo) for the full output duration; for each placed clip, decode its cached wav (24 kHz mono) → resample to export rate (reuse the `OfflineAudioContext` `resampleMono` helper in `src/lib/captioning/extractMono16k.ts`) → mono→stereo → write samples at the clip's `startMs`; then chunk-encode via WebCodecs `AudioEncoder` → `muxer.addAudioChunk`.
- `audioEncoder.ts`: add `synthesizeVoiceoverTrack`; reuse existing codec selection (`selectSupportedExportCodec`) and channel helpers.
- `gifExporter.ts`: unchanged (GIF has no audio).

### 8.7 Preview — `src/components/video-editor/VideoPlayback.tsx`

- When `voiceover.enabled`: mute the `<video>` element's audio.
- Maintain an `AudioContext`; schedule each placed clip on an `AudioBufferSourceNode` at its `startMs` relative to the playhead. Reschedule on play/pause/seek/scrub and when the layout changes. This is the highest-risk piece — prototype first.

## 9. Alignment algorithm (`layoutVoiceover`)

Pure function, computed once and consumed identically by preview and export so they can never disagree:

```
layoutVoiceover(
  segments: VoiceoverSegment[],
  clipDurationMsById: Record<string, number>,   // from synthesis result
  trimRegions: TrimRegion[],
  speedRegions: SpeedRegion[],
): Array<{ segmentId: string; audioKey: string; startMs: number; durationMs: number }>
```

1. **Anchor**: each clip wants to start at `segment.sourceStartMs`.
2. **Map source → output**: transform the anchor through trims and speed using the same math the exporter already applies to audio timestamps (`computeTrimOffset` in `audioEncoder.ts`; extend to a shared helper if needed).
   - Anchor inside a **trimmed (removed)** region → **drop** the clip (its words were cut).
   - Anchor inside a **sped-up** region → map the start; the clip plays at natural length (it is NOT stretched to match the sped-up video). Minor intra-region drift — documented limitation.
3. **Resolve overlap ("nudge right")**: process clips in output-time order; if a clip's mapped start is before the previous clip's end, push it to `prevEnd + gap` (~40 ms). Clips never overlap; when the edited script is denser than original pacing, clips play back-to-back. Cumulative drift on heavy edits is the accepted tradeoff (light cleanup edits stay tight).

## 10. Integration risks & mitigations

- **kokoro-js depends on `@huggingface/transformers`**, while the repo currently uses the older `@xenova/transformers` for captioning. Adding kokoro-js may pull a second transformers package. Mitigation: apply the same `vite.config.ts` node-builtin stubs (`fs`/`path`/`url` + `onnxruntime-node` → `src/lib/vite-stubs/`) to `@huggingface/transformers`; verify the renderer bundle stays web-only; confirm both packages can coexist or migrate captioning if trivial. Evaluate bundle-size/dedup impact. **This must be validated in the first implementation step.**
- **Preview audio/video sync** — prototype the Web Audio scheduling against the `<video>` clock early; it is the trickiest UX piece.
- **Installer size (+~92 MB)** — reuse `caption-assets` asar-unpack + candidate-path resolution; confirm packaged offline load.
- **First-run worker warm-up latency** — mirror the Whisper worker's status/preparing UX.
- **English-only in v1** — Kokoro multi-language deferred; surface clearly in UI copy.
- **Heavy-edit drift & speed-region drift** — documented limitations; acceptable for the light cleanup use case.

## 11. i18n

All user-facing strings go through `useScopedT` under a new `voiceover` namespace, added to **all locales** (baseline `en`). If any native menu/dialog strings are needed, mirror them in `electron/i18n.ts` (`mainT`). Verify with `npm run i18n:check`.

## 12. Testing plan (three tiers per docs/tests/writing-tests.md)

- **Unit (jsdom):**
  - `segmentation.ts` — sentence grouping, silence-gap split, max-length cap, anchor assignment.
  - `layout.ts` — anchoring, source→output mapping through trims/speed, drop-in-trim, overlap nudging, drift accumulation.
  - Content-hash keying (same inputs → same key; changed text/voice/speed → new key).
- **Browser (real Chromium):**
  - Kokoro worker synthesizes non-empty 24 kHz PCM for sample text (may gate on model availability).
  - `synthesizeVoiceoverTrack` produces a correctly-timed PCM buffer; WebCodecs `AudioEncoder` encodes it; mux produces a valid audio track.
- **E2E (Playwright, optional):** enable voiceover → edit a segment → generate → export → assert output has an audio track of expected duration.

## 13. v1 implementation phasing (suggested order)

1. **Spike:** integrate kokoro-js + worker; validate the `@huggingface/transformers` / vite-stub / bundling story; synthesize PCM from text in the renderer. (De-risks §10.)
2. **Engine layer:** `src/lib/tts/` provider + worker + voices; bundled-asset loading.
3. **Data + segmentation:** `VoiceoverConfig`/`VoiceoverSegment` in `EditorState`; `segmentation.ts`; `useVoiceover` seeding + status.
4. **Persistence:** native-bridge `voiceover` domain + cache; project serialize + version bump/migration.
5. **UI:** `VoiceoverPanel` (edit, voice, speed, generate) + status; timeline voiceover row.
6. **Alignment:** `layoutVoiceover` pure function + tests.
7. **Preview:** Web Audio scheduling; mute `<video>` when enabled.
8. **Export:** `synthesizeVoiceoverTrack` replace-mode path; encode + mux.
9. **Polish:** i18n, edge cases, docs (update folder CLAUDE.md files where structure changes).

## 14. Open questions (non-blocking)

- Default Kokoro voice and the curated subset to expose in the picker.
- Exact silence-gap threshold and max-clip-length values (tune during implementation).
- Whether to expose a "reset script to transcript" action in v1 (low cost; likely yes).
- Project portability: whether a later phase should export voiceover audio into a project asset bundle for cross-machine sharing (currently re-derived from cache).

## 15. Plan 3 resolved decisions (2026-07-01)

Resolved during Plan 3 brainstorming (after Plans 1 & 2 landed). These refine §8.4 and §9 for the UI + alignment slice; nothing else in the spec changes.

- **Panel integration:** the editor's right panel is a nav-rail driven by `activePanelMode: SettingsPanelMode` (local state in `SettingsPanel.tsx`), **not** a `<Tabs>` control. Voiceover surfaces as a new **project-wide** panel mode `"voiceover"` (always available, like Background/Export — not gated on a timeline selection). Its content is a **standalone `VoiceoverPanel` component** (own file), prop-drilled `VideoEditor → SettingsPanel → VoiceoverPanel`. Per-segment UI splits into a `VoiceoverSegmentRow` component for isolation/testability.
- **Timeline row is source-time (refines §8.4).** The timeline axis is **source time** (`range = {0, videoDurationMs}`; trims/speed rendered as spans on it). The read-only "Voiceover" row therefore renders each **ready** clip at its `sourceStartMs` with **natural width**, and **dims** clips whose anchor falls in a trim — it does **not** render `layoutVoiceover`'s output-time result. A shared pure predicate `isAnchorTrimmed(sourceStartMs, trims)` is used by both the row (dim) and `layoutVoiceover` (drop). Clicking a clip selects its segment (`selectedVoiceoverSegmentId`, runtime state) and switches the panel to `"voiceover"` mode; it does **not** trigger the region-settings contextual view.
- **`layoutVoiceover` is built + fully unit-tested in Plan 3, but its runtime consumers (preview/export) arrive in Plan 4.** Signature takes `{ segments, clipsById: Record<id,{audioKey,durationMs}> (ready only), trims, speedRegions, gapMs? }` and returns `PlacedClip[] { segmentId, audioKey, startMs, durationMs }`. Output-time mapping subtracts trim offset (mirrors `computeTrimOffset`) **and** speed-region savings `(Δ)(1−1/s)` (no existing speed-aware helper — new here); clips play at **natural** length (start mapped only); overlaps nudge right by `gapMs` (~40). Anchor-in-trim drops the clip.
- **Per-segment audition only (Plan 3); timeline-synced preview stays Plan 4.** A small `useClipAudition` hook owns one `AudioContext` and plays a single cache-resolved clip (`clips[status.audioKey]` → `AudioBuffer`). This is the only audio playback in Plan 3.
- **Voice picker uses the static `KOKORO_VOICES` list** (English subset from Plan 1), not async `listVoices()` — keeps the picker synchronous. **Speed slider** clamps 0.7–1.2.
- **Seeding:** auto-`seedFromTranscript()` on first enable when `segments` is empty and the transcript is ready; also expose a manual "Reset script to transcript" action (resolves the §14 open question — yes).
- **i18n as-you-go:** add a new `voiceover` namespace to **all 13 locales** and use `useScopedT("voiceover")` from the start (per the repo convention); Plan 4 adds only its own preview/export strings. No native-menu strings expected (`electron/i18n.ts` untouched).
- **Carried-over cleanups folded into Plan 3** (from Plan 2's final review): (a) in-flight guard in `useVoiceover.generateSegment`; (b) browser-tier view-backed PCM round-trip test; (c) produce the `SegmentSynthStatus "queued"` state from `generateAll`; (d) optional trim/annotate of the now-dead `fs/promises`+`path` entries in `vite-plugins/stubNodeBuiltins.ts`.

**Plan boundary:** Plan 3 = UI + alignment + hook wiring (this section). Plan 4 = Web-Audio timeline-synced preview + `synthesizeVoiceoverTrack` export + polish.

## 16. Plan 4 resolved decisions (2026-07-02)

Resolved during Plan 4 brainstorming (after Plan 3 landed). These make `layoutVoiceover` reachable at runtime — preview + export — and refine §8.6/§8.7. Nothing earlier in the spec changes. (Preview approach was recommended by the assistant and taken by best-judgment default while the user was away; revisit if the user disagrees.)

- **Single source of output-time truth.** `VideoEditor` computes `voiceoverPlacedClips = layoutVoiceover({ segments, clipsById, trims, speedRegions })` **once** (memoized) from ready `statuses` (→ `clipsById: {audioKey,durationMs}`), and passes the **same `PlacedClip[]`** to *both* the preview (via `VideoPlayback`) and the exporter config (built at export click-time). Preview and export therefore consume byte-identical placements and cannot disagree.

- **Shared pure bed builder.** `src/lib/voiceover/bed.ts` exports `buildVoiceoverBedMono({ placedClips, clipSamplesByKey, sampleRate, totalSamples }): Float32Array` — writes each clip's (already-at-`sampleRate`) samples into a silent mono bed at `round(startMs/1000 · sampleRate)`, clamped to bounds. Pure/array-only → jsdom-unit-testable. Used by preview (24 kHz, clips native → no resample) and export (48 kHz, clips resampled first).

- **Preview = one pre-mixed output-time `AudioBuffer` (Approach P1).** New `src/hooks/useVoiceoverPlayback.ts` owns one `AudioContext` + one `AudioBufferSourceNode`, called inside `VideoPlayback` (where `videoRef`, `supplementalAudioRef`, and `isScrubbing` live). It builds a mono 24 kHz `AudioBuffer` from `buildVoiceoverBedMono` (memoized; rebuilt when placements/clips change). Scheduling model rests on the invariant that **output time advances at ~1× wall-clock during playback** (a speed region plays source faster but compresses to 1× output; trims are near-instant seeks):
  - On play: `await ctx.resume()`, create a source from the buffer, `start(ctx.currentTime, offset = mapSourceToOutputMs(video.currentTime, trims, speed)/1000)`.
  - On pause or while scrubbing: stop the source (silent during scrub).
  - **Re-anchor triggers are `enabled` / `isPlaying` / `isScrubbing` (+ buffer identity) — NOT raw `seeked`.** Trim-skip seeks during continuous playback don't change those signals, so the single buffer keeps playing without a restart/glitch. A user seek while paused changes the offset on next play; a scrub settles (`isScrubbing→false`) and re-anchors if playing.
  - **Bounded soft re-sync (drift control).** Two independent clocks (the `<video>` element and the `AudioContext`) plus trim-skip seek latency (the video stalls during the async `currentTime = trim.endMs` seek while the buffer keeps playing) make the audio creep *forward* by roughly `Σ(seek latency)` across a play span. To cap this without restarting on every trim (which would click), a low-frequency check (a lightweight interval and on `seeked`, only while playing and not scrubbing) compares the buffer's actual position `ctx.currentTime − startedAtCtx + startedAtOffset` against the expected `mapSourceToOutputMs(video.currentTime, trims, speed)/1000`; if `|drift|` exceeds a threshold (~100 ms), it recreates the source at the corrected offset. This keeps preview drift bounded and glitch-rare — strictly tighter than the existing supplemental-audio sync (which tolerates 50–150 ms and re-syncs the same way). Speed-region mid-clip mismatch (clips play at natural length over sped visuals) remains the documented §10 limitation, not a clock desync.
  - **Export contrast (why export can't drift).** Export has no real-time clock: video frame timestamps (`N/fps`) and the voiceover bed (`effectiveDuration` long, clips at absolute `startMs`) share one output-time axis, so placement is frame-accurate by construction. The only offset is AAC encoder priming — a *constant* delay identical to the existing source-audio export path (same encoder/muxer), not accumulating skew.
  - When `enabled`: set `video.muted = true` **and** gate the supplemental-audio effect off via a new `voiceoverEnabled` prop on `VideoPlayback` (the supplemental `<audio>` otherwise plays the original narration). Testable with a mocked `AudioContext` + a fake video element.

- **Export replace-mode** (`videoExporter.ts` + `audioEncoder.ts`). Extend `VideoExporterConfig` with `voiceover?: { enabled: boolean; placedClips: PlacedClip[]; clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }> }`. When `enabled && placedClips.length > 0` → **replace mode**:
  - Select the output codec via `AudioProcessor.selectSupportedExportCodec(48000, 2)` (independent of the source track), construct the muxer with `hasAudio=true` + that codec, and **skip the source-audio decode/encode path entirely**.
  - After the video encode + flush, call `AudioProcessor.synthesizeVoiceoverTrack(placedClips, clipPcmByKey, outputDurationMs, codec, muxer)`: allocate a silent 48 kHz stereo track of `outputDurationMs` (from `streamingDecoder.getExportMetrics(frameRate, trims, speed).effectiveDuration`); resample each 24 kHz mono clip → 48 kHz; place via the shared bed builder; duplicate mono→stereo; chunk into `AudioData` frames → `AudioEncoder` → `muxer.addAudioChunk`.
  - **Source-copy fast path gains a blocker** when replace mode is active (`config.voiceover?.enabled && placedClips.length > 0`) — otherwise a zero-edit + voiceover export would copy the source **with** its original audio.
  - `enabled` but **0 ready placed clips** (nothing generated, or all anchors trimmed) → export **video-only** and push a warning (surfaced via the existing warnings→toast path). Source audio stays muted per the locked "always fully muted" decision.
  - Testing: pure bed placement in jsdom; a browser-tier test that `synthesizeVoiceoverTrack` encodes + muxes a valid, correctly-timed audio track (WebCodecs available).

- **Folded-in deferred Plan-3 minors:** (a) `useCallback` the `onChange` passed to `useVoiceover` in `VideoEditor` (stops the auto-seed effect re-running each render); (b) `useClipAudition` — `await ctx.resume()` before `start()` + the 3 missing test assertions (replaced-source stop / natural `onended` clears key / unmount closes ctx).

- **Out of scope (separate follow-up):** the pre-existing `timeline.json` non-`en` i18n debt (`buttons.autoZoom*/autoFocusAll*`, present since branch start `db1c657`). Plan 4 keeps the `voiceover` namespace at full parity; `npm run i18n:check` still fails only on that unrelated debt.

**Plan boundary:** Plan 4 is the final slice — after it, voiceover is reachable end-to-end (generate → preview → export). Follow-up: network-disabled `npm run build:mac` to confirm true offline Kokoro voice loading (deferred since Plan 1).
