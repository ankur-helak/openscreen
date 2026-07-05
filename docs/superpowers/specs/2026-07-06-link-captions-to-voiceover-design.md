# Link Captions to the Voiceover Script — Design Spec

- **Date:** 2026-07-06
- **Status:** Approved for planning (pending final spec review)
- **Branch:** `feat/link-captions-to-voiceover` (off `feat/ai-voiceover`)
- **Feature area:** `src/lib/captioning/`, `src/lib/voiceover/`, video editor (`VideoEditor.tsx`, `VideoPlayback.tsx`, timeline), export pipeline (`frameRenderer.ts`, `videoExporter.ts`)

## 1. Summary

Today the on-screen **captions** and the **AI voiceover script** are two independent copies of the same words, forked from the transcript and never reconciled. When a user edits the voiceover script (or the generated voice differs in length from the original speech), the captions no longer match what is spoken — in wording **and** in timing.

This change makes the **voiceover script the single source of truth for the words while voiceover is on**: captions are derived from the script, chunked at the user's caption granularity, and timed to the synthesized (TTS) audio. Caption styling becomes a single global style that persists across edits and across voiceover on/off. The redundant caption timeline lane collapses into the voiceover/script lane.

## 2. Problem (verified against current code)

The transcript (`useTranscript.ts`, cached via the native bridge) is the shared origin, but each feature immediately makes an independent, separately-editable copy and they never talk again:

- **Captions** → `annotationRegions` with `annotationSource: "auto-caption"` (`captionSegmentsToAnnotationRegions`, `src/lib/captioning/annotationsFromCaptions.ts`). Word/phrase granularity (2–7 words), timed to the **original** audio. Editing a caption writes only to that region (`handleAnnotationContentChange`, `VideoEditor.tsx`).
- **Voiceover** → `voiceover.segments` (`seedFromTranscript`, `useVoiceover.ts` + `segmentTranscript`, `src/lib/voiceover/segmentation.ts`). Sentence granularity, seeded once, edited independently (`handleVoiceoverSegmentTextChange`).

Two concrete defects result:

1. **Text divergence.** Edit the spoken script and the caption still shows the old words (and vice versa). No sync code exists.
2. **Timing drift (guaranteed, even with identical words).** When voiceover is active it mutes the original audio and plays TTS (`VideoPlayback.tsx`, `videoExporter.ts` → `synthesizeVoiceoverTrack`). Voiceover clips are re-laid-out to output time using **TTS clip durations** (`layoutVoiceover`, `src/lib/voiceover/layout.ts`), but captions still render at their **original** transcript times (`VideoPlayback.tsx`, `frameRenderer.ts` `renderAnnotations`). Because a synthesized clip's length ≠ the original spoken length, captions drift out of sync with the voice within and after every segment.

## 3. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Source of truth | **Script is master while voiceover is on.** Caption words come from `voiceover.segments`; timing from the TTS layout. |
| 2 | Granularity | **Unchanged** — user's caption min/max words still governs chunking; reuse existing caption word-grouping logic. |
| 3 | Independence | Captions and voiceover are **independent toggles**; the link activates only when **both** are on and **≥1 clip is generated**. Enabling voiceover does **not** auto-create captions. |
| 4 | Voiceover OFF | Captions **revert to the transcript** (original words + original timing) — i.e. today's behavior. |
| 5 | Caption styling | **One global caption style** (font, size, animation, position, colours), persisted, applied to all captions in **both** modes. |
| 6 | Style persistence | Caption **style survives re-sync** — syncing updates only words + timing, never style. |
| 7 | Text editing while linked | Caption **words** are edited in the script (not on the caption). Caption **style** stays fully editable via the existing controls. |
| 8 | Timeline | With voiceover on, captions get **no separate lane**; the voiceover/script lane is their single representation. Other annotations keep their lane. |
| 9 | Ungenerated segments | **No caption** for a segment with no generated clip (nothing is spoken there). |

## 4. Goals / Non-goals

### Goals
- One source of truth for the words while voiceover is on (script → captions).
- Captions timed to the TTS audio (fixes the drift bug) in both preview and export.
- Single global caption style, persisted and consistent across voiceover on/off, editable with the existing text-annotation controls.
- Collapse the redundant caption lane into the voiceover lane while voiceover is on.
- No regression to standalone captions when voiceover is off.

### Non-goals
- Making the transcript itself directly editable / a transcript editor.
- Per-segment or per-line caption styling (explicitly replaced by one global style).
- Two-way sync (editing a caption to change the spoken words).
- Changing voiceover segmentation, synthesis, or the audio pipeline.
- Multi-language / translated captions that intentionally differ from speech.

## 5. Architecture

### 5.1 State model
- **Global caption style** — a single persisted, undoable object holding the fields exposed by the text-annotation panel that apply to captions: font family, font size, text animation, position, colours. Applied to all caption regions in both modes.
- **Caption granularity** — persist `minWords` / `maxWords` (today only passed at generate-time in the Auto-captions dialog) so the derived projection can re-chunk.
- **Voiceover** (`voiceover.segments`, statuses, clips) — unchanged; remains the word master when on.
- Placement of the above (extend an existing caption-settings slice vs. add a `captions: { enabled, minWords, maxWords, style }` object) is a planning detail; the model above is the requirement.

### 5.2 Derivation (pure function)
New pure module, e.g. `src/lib/voiceover/captionsFromScript.ts`:

    captionRegionsFromScript({
      segments,          // VoiceoverSegment[] (words)
      placed,            // output-time layout from layoutVoiceover: { segmentId, startMs, durationMs }
      statuses,          // to select only "ready" segments
      minWords, maxWords,
      style,             // global caption style
    }): AnnotationRegion[]

Algorithm per ready segment (sorted by `sourceStartMs`):
1. Build one merged caption span in **SOURCE time**: `startSec = sourceStartMs/1000`, `endSec = (sourceStartMs + ttsDurationMs)/1000` — i.e. anchor at the segment's source start, length = the TTS clip's duration. Clamp `endSec` so it does not overlap the next ready segment's `sourceStartMs`.
2. Chunk into caption lines with the **existing** `splitMergedCaptionsByWordBounds(merged, minWords, maxWords)` (`annotationsFromCaptions.ts`), which spreads each span's duration across its words by character weight — exactly the Auto-captions promise *"Timing is spread across the words in that phrase."*
3. Emit an `AnnotationRegion` per line: `content`/`textContent` = line text, `startMs`/`endMs` from the chunker, `annotationSource: "auto-caption"`, styled by the global caption style.

**Resolved time-base (was the §5.3 risk):** annotation regions are rendered in **SOURCE time** in both preview (`VideoPlayback.tsx` compares `currentTime` = raw `<video>` source time) and export (`frameRenderer.ts`/`annotationRenderer.ts` compare the per-frame **source** timestamp) — the two agree and neither maps annotations through trims/speed. Therefore derived captions are authored in **source time** anchored on `sourceStartMs` (above); we do **not** feed `layoutVoiceover`'s output-time `startMs` into annotation `startMs`. Only the TTS **duration** (from the ready clip / `voiceoverStatuses[id].durationMs`) is used, not the output-time placement. This keeps captions consistent with the existing source-time caption/annotation convention.

The function is deterministic and fully unit-testable (chunking, source-time anchoring, overlap clamping, ungenerated handling).

### 5.3 Rendering integration
Introduce a derived `effectiveAnnotationRegions` in `VideoEditor.tsx`, fed to **both** preview (`VideoPlayback`) and export (`videoExporter`):

- **Linked** (voiceover on + captions on + ≥1 ready clip): `effective = (stored annotations minus auto-caption regions) + captionRegionsFromScript(...)`.
- **Not linked**: `effective = annotationRegions` (unchanged).

The stored auto-caption regions are **never mutated**, so turning voiceover off reverts for free (Decision 4). No renderer changes are needed — both renderers already render whatever regions they are handed. **Time-base:** resolved — annotations render in source time in both preview and export (see §5.2), so derived captions are authored in source time; no clock reconciliation with `layoutVoiceover`'s output time is needed.

When **not** linked, `effective` also applies the global caption style to any stored `auto-caption` regions, so caption styling is consistent whether voiceover is on or off (Decision 5) without mutating stored state.

### 5.4 Editing model
- **Words (linked):** edited via the voiceover script segment; the caption's own text field is read-only/reflects the script.
- **Style (both modes):** the global caption style, edited with the existing font/size/animation/position controls. Selecting a caption on the video canvas (and/or its script segment) opens these controls bound to the global style.
- **Words (voiceover off):** unchanged — captions are editable transcript-derived regions, now wearing the global style.

### 5.5 Timeline
With voiceover on, derived captions are not stored annotation regions, so they do not populate the annotation lane — the voiceover/script lane is the single representation of the spoken/caption content. Non-caption annotations (arrows, manual text) are unaffected.

## 6. Data flow (target)

    transcript.segments (shared origin)
            │
            ├─ voiceover OFF ─────────────► captions = stored auto-caption regions
            │                                (transcript words + original timing)
            │                                styled by GLOBAL caption style ── render
            │
            └─ voiceover ON + captions on + ≥1 ready clip ─┐
                                                            ▼
         voiceover.segments (words) ── layoutVoiceover (output time + TTS durations)
                                                            │
                          captionRegionsFromScript(words, layout, min/max, GLOBAL style)
                                                            │
                 effective = non-caption annotations + derived captions
                                                            │
                                       preview (VideoPlayback) + export (frameRenderer)

## 7. Edge cases
- **Ungenerated segment:** no caption (Decision 9).
- **Voiceover on, captions on, zero clips ready yet:** not "linked" — nothing derived is shown until the first clip is ready.
- **Voiceover on, captions off:** no captions (independent toggles).
- **Mixed annotations:** manual text/arrow annotations always pass through untouched.
- **Undo/redo:** words are undoable via the script (`voiceover.segments`); global caption style is undoable. Derived captions are computed, so they carry no separate history.

## 8. Testing
- **Unit:** `captionRegionsFromScript` — word→line chunking honoring min/max, proportional timing spread across a clip's duration, ready/ungenerated selection, style application.
- **Unit/integration:** `effectiveAnnotationRegions` selection logic (linked vs not; auto-caption regions replaced, others preserved).
- **Render check:** preview and export use derived captions when linked and stored captions when not (extend the existing e2e/browser export coverage where practical).
- **Regression:** voiceover-off captions behave as today (plus global style).

## 9. Intended changes / trade-offs (call-outs)
1. **Per-caption individual styling is removed** in favour of one global caption style (Decision 5) — affects standalone captions too, on and off.
2. **While linked, caption text is not edited on the caption** — words are edited in the script (Decision 7); style stays editable.
3. **Time-base** (§5.2) — resolved: annotations render in source time in both preview and export, so derived captions are authored in source time anchored on `sourceStartMs` with TTS-duration length. No longer an open risk.

## 10. Affected components (indicative)
- New: `src/lib/voiceover/captionsFromScript.ts` (+ tests).
- Reuse: `groupTimedCaptionWordsIntoLines` / caption grouping from `src/lib/captioning/annotationsFromCaptions.ts`; `layoutVoiceover` from `src/lib/voiceover/layout.ts`.
- `src/components/video-editor/VideoEditor.tsx` — global caption style + min/max state, `effectiveAnnotationRegions`, wiring to preview/export, caption-selection → style controls.
- `src/components/video-editor/VideoPlayback.tsx` — consume `effectiveAnnotationRegions`.
- `src/lib/exporter/videoExporter.ts` / `frameRenderer.ts` — consume `effectiveAnnotationRegions`.
- Timeline (`src/components/video-editor/timeline/`) — suppress the caption lane when linked.
- Auto-captions dialog + caption style surface — persist min/max, edit the global style.
- i18n locales for any new/changed strings.
