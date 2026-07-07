# AI Script Polish — Design Spec

- **Date:** 2026-07-07
- **Status:** Approved for planning (pending final spec review)
- **Branch:** `feat/ai-script-polish` (off `feat/caption-model-whisper-base-en`, which carries the
  full AI-voiceover + linked-captions foundation)
- **Feature area:** new `src/lib/script/`, `electron/native-bridge/`, `src/native/`,
  `src/hooks/`, `src/components/video-editor/` (`VoiceoverPanel`, `VoiceoverSegmentRow`),
  app settings

## 1. Summary

Add an **AI Script Polish** pass that rewrites the recorded transcript **in place, per segment**,
so the words the AI voiceover speaks (and the linked captions that mirror them) read like a clean,
intentional script instead of raw mumbled speech. The rewrite preserves every segment's identity
and timeline anchor, so the existing voiceover synthesis, script→caption derivation, and timeline
layout all follow **for free** — no new timing, caption, or export code.

This is the "polish the script" pass that the original AI-voiceover spec
(`2026-07-01-ai-voiceover-replace-narration-design.md` §5, non-goals) explicitly deferred. It is
the first feature to use a **cloud LLM (OpenAI, bring-your-own-key)**, and it lays the
main-process BYO-key foundation that later cloud features (dubbing, doc export) will reuse.

## 2. Motivation

Writing a clean voiceover script by hand is the single biggest friction stopping people from
using the AI voiceover at all. Users record naturally (rambling, filler words, false starts),
and today the only way to get a polished narration is to hand-edit every segment. An AI polish
pass removes that friction: record rough, click one button, get a clean script — then fine-tune.

Because the voiceover pipeline already treats `voiceover.segments[i].text` as the single source
of truth for both the synthesized voice **and** the linked captions, rewriting that text is the
highest-leverage, lowest-surface way to add real AI value.

## 3. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Input scope | **Recorded transcript only** (polish/rewrite existing segments) | Keeps anchors; timing stays solvable; reuses all existing infra |
| 2 | Rewrite granularity | **Per-segment, in place** — segment count and `sourceStartMs`/`sourceEndMs` anchors never change | The whole timing/caption/cache model is anchored per segment |
| 3 | Timing adherence | **Natural-with-drift** — length-aware prompting minimizes mismatch; residual handled by existing `layoutVoiceover` anchor/nudge/gap | No audio manipulation, no video retiming; zero new timing code |
| 4 | Review model | **Apply-all + per-segment revert + re-polish**, under undo/redo | Mirrors the existing "Generate all" + per-segment-regenerate pattern; lowest friction |
| 5 | Tone control | **Presets only, project-wide** | Simple, discoverable; matches the locked "single project-wide voice + speed" |
| 6 | Provider | **OpenAI, cloud-only**, behind a `ScriptPolishProvider` seam | User preference; seam keeps future Anthropic/local swap cheap |
| 7 | Key handling | **Bring-your-own-key**, stored via Electron `safeStorage`, call runs in the **main process** | Key never enters the renderer bundle; single network + consent choke point |
| 8 | Availability | **Polish requires voiceover to be enabled** | Polish only makes sense when the script drives a synthesized voice |

## 4. Goals / Non-goals

### Goals (v1)
- One-click "Polish script" that rewrites all voiceover segments in place via OpenAI.
- Per-segment **re-polish** and **revert** (to the pre-polish text), all undoable.
- **Project-wide tone presets** that steer the rewrite.
- **Length-aware** rewriting: each segment is given a word budget derived from its original
  spoken duration, so synthesized lengths stay close to the original and drift stays small.
- **BYO-key OpenAI foundation**: secure key storage (main process), a first-use privacy consent,
  and a new native-bridge `scriptPolish` domain — reusable by later cloud features.
- Automatic downstream: changed segments re-synthesize (via existing content-hash cache) and
  linked captions re-derive (via existing `captionsFromScript`) with no new code.
- Full i18n parity for all new strings.

### Non-goals (future phases)
- From-scratch script generation (write from bullet points / a prompt; narrate over B-roll).
- Free-text custom tone instructions; per-segment tone overrides.
- Merge/split re-segmentation of the script (would require re-anchoring).
- Speed-fit or video-retime timing strategies ("video follows the words").
- Local / offline LLM fallback for polishing.
- Translation / dubbing (separate feature that will reuse this BYO-key foundation).
- Sending audio or video frames to OpenAI — **v1 sends segment text only.**

## 5. Architecture

Mirrors the existing provider seams (`TtsProvider` in `src/lib/tts/provider.ts`,
`TranscriptionProvider` in `src/lib/transcription/types.ts`) and the native-bridge layering
(`adapter/provider → service → transport → client`).

```
ScriptPolishProvider (interface)            src/lib/script/provider.ts   (shared seam + types)
  └─ scriptPolishService (OpenAI impl)      electron/native-bridge/services/…  (MAIN process)
        │   native bridge: scriptPolish.polish({ segments, tone, targets })
        ▼
useScriptPolish (renderer hook)             src/hooks/useScriptPolish.ts
        │   applies results → writes voiceover.segments[i].text (undoable editor state)
        ▼
EXISTING, unchanged:
  useVoiceover ─────────► re-synthesizes ONLY changed segments (audioKey content hash)
  captionsFromScript ───► linked captions re-derive automatically
  layoutVoiceover ──────► timeline placement (anchor/nudge/gap) unchanged
```

The OpenAI request runs in the **main process** (Electron), reached through a new native-bridge
domain `scriptPolish`. The renderer never sees the API key. The main process is the single point
that (a) reads the key from `safeStorage`, (b) enforces the first-use consent gate, and (c) makes
the network call.

## 6. Data model

### 6.1 Undoable editor state (participates in undo/redo)

`VoiceoverSegment` (`src/lib/voiceover/types.ts`) gains one optional field:

```ts
interface VoiceoverSegment {
  id: string;
  sourceStartMs: number;
  sourceEndMs: number;
  text: string;
  textBeforePolish?: string;   // NEW: snapshot captured at polish time → per-segment revert
}
```

`VoiceoverConfig` gains one optional field:

```ts
interface VoiceoverConfig {
  // …existing…
  polishTone?: string;         // NEW: preset id (project-wide); undefined → default preset
}
```

Both are serialized into the project JSON (`projectPersistence.ts`); bump `PROJECT_VERSION` with a
migration that defaults `polishTone` to undefined and leaves `textBeforePolish` absent for older
projects.

### 6.2 Runtime (non-undoable) state

A new `useScriptPolish` hook holds per-segment polish status, mirroring the shape of
`SegmentSynthStatus`:

```ts
type SegmentPolishStatus =
  | { state: "idle" }
  | { state: "queued" }
  | { state: "polishing" }
  | { state: "error"; message: string };
```

No new cached artifacts. Polished words live in the segment; audio is still keyed by the existing
`audioKey = sha1(text + voice + speed + engine + model)`, so editing a segment's text naturally
invalidates only that clip.

## 7. The polish flow

### 7.1 Request (batched)

"Polish script" issues **one batched request** for all segments (better cross-segment coherence —
consistent tense/voice, no repeated openers — and one round-trip / lower cost). Each segment is
sent as `{ id, text, targetWords }` where:

```
targetWords = round(((sourceEndMs - sourceStartMs) / 1000) * WORDS_PER_SECOND)
```

`WORDS_PER_SECOND ≈ 2.5` (~150 wpm), tunable. The prompt instructs the model to rewrite each
segment to roughly its `targetWords` budget, preserve the speaker's meaning and a natural
conversational voice, apply the selected **tone preset**, and return exactly one rewrite per input
id.

### 7.2 Response (structured, id-keyed, validated)

The provider returns structured output: an array of `{ id, text }`. The renderer validates that
the response contains **exactly one entry per requested id** (no merges, splits, extras, or
omissions). On any mismatch the pass is treated as **failed and applied atomically as nothing** —
this guarantees the per-segment anchor invariant (Decision 2) can never be violated by a
misbehaving model.

### 7.3 Apply

On success, in a single undoable action: for each segment set
`textBeforePolish = text` (snapshot), then `text = result.text`. Downstream re-synthesis and
caption re-derivation happen through existing wiring.

- **Per-segment re-polish:** a single-segment request with the same tone; updates that segment's
  `text` and refreshes its `textBeforePolish` snapshot to the pre-re-polish text.
- **Per-segment revert:** one step back — restore `text = textBeforePolish`, then clear
  `textBeforePolish`. This restores whatever the segment held immediately before its most recent
  polish (which may be a prior hand-edit, not necessarily the raw transcript), deliberately
  preserving manual edits.
- **Going further back:** undo/redo steps through each polish action, and the existing global
  "reset script to transcript" restores every segment to the original recorded words in one action.

## 8. UI

Additions to the existing `VoiceoverPanel` / `VoiceoverSegmentRow`; no new panel.

- **Panel header:** a **tone-preset dropdown** and a **"Polish script"** button with aggregate
  progress, placed near the existing "Generate all" control.
- **Segment row:** a polish **status chip**, a **re-polish** action, and a **revert** action shown
  only when `textBeforePolish` is present.
- **Gating (Decision 8):** the Polish controls are visible only when `voiceover.enabled` is true.
- **No key set:** the Polish controls are disabled with an "Add OpenAI key" affordance that opens
  the settings surface (see §9).

Tone presets (initial set, tunable): `professional`, `conversational` (default),
`concise`, `enthusiastic`, `tutorial`. The `conversational` default is phrased to preserve the
speaker's own phrasing, directly countering the "sounds too AI-generated" failure mode.

## 9. BYO-key & privacy

- **Storage:** the OpenAI API key is a **global app setting** (not per-project), written and read
  in the main process via Electron **`safeStorage`** (OS keychain-backed). If `safeStorage` is
  unavailable on a platform, fall back with a clear warning; never write the raw key to plain
  project or config files.
- **Settings surface:** a field to paste/clear the key (renderer never receives it back — it shows
  only a "key set / not set" state).
- **Consent:** a first-use disclosure that segment **text** (no audio, no frames) is sent to
  OpenAI for polishing, with a "don't show again". Enforced in the main process before the first
  network call.
- **Everything else stays offline:** with no key set, the entire rest of the app (recording,
  on-device voiceover, captions, export) is unaffected.

## 10. Error handling & edge cases

- **No key** → Polish controls disabled + "Add OpenAI key" affordance.
- **API / network / rate-limit / timeout error** → per-segment `error` status + a toast via the
  existing warnings channel; offer retry. A failed batch applies **nothing** (atomic).
- **Response id mismatch** (§7.2) → treated as a failed pass; nothing applied.
- **Empty / whitespace-only segment** → skipped (nothing to polish).
- **Segment anchored inside a trim** → still polishable (it is just text); `layoutVoiceover`
  already drops trimmed clips from playback/export.
- **Voiceover disabled** → Polish is unavailable (Decision 8).
- **Undo/redo** → polish-all is one undoable action; per-segment revert/re-polish are each
  undoable; `textBeforePolish` travels with the segment in history.

## 11. Testing (three tiers per `docs/tests/writing-tests.md`)

- **Unit (jsdom):**
  - `targetWords` budget math from segment duration.
  - Structured-response validation: exact id-set match required; missing/extra/duplicate ids →
    rejected; well-formed → accepted.
  - Apply logic: snapshots `textBeforePolish`, writes new text, only edited segments change their
    `audioKey`; revert restores and clears the snapshot; tone flows into the request payload.
- **Unit/integration:** applying results triggers re-synthesis of exactly the changed segments and
  re-derivation of linked captions (assert via the existing hooks/selectors, OpenAI mocked).
- **E2E (Playwright, optional):** enable voiceover → Polish → confirm segment text changed and a
  changed clip re-synthesizes; OpenAI call mocked.
- **i18n:** new `scriptPolish` namespace + tone-preset labels added to **all 13 locales**
  (baseline `en`); `npm run i18n:check` green.

## 12. Affected components (indicative)

- **New:** `src/lib/script/provider.ts` (interface + shared request/response types + budget math);
  `electron/native-bridge/services/scriptPolishService.ts` (OpenAI call, key read, consent);
  `src/hooks/useScriptPolish.ts`; settings key-management surface.
- **Native bridge:** add `scriptPolish` action(s) to `src/native/contracts.ts`, client method in
  `src/native/client.ts`, transport dispatch, service registration in the factory/store.
- **Changed:** `src/lib/voiceover/types.ts` (fields); `projectPersistence.ts` (`PROJECT_VERSION`
  bump + migration); `VoiceoverPanel.tsx` / `VoiceoverSegmentRow.tsx` (controls); `VideoEditor.tsx`
  (wire `useScriptPolish`, apply results into undoable state).
- **Unchanged (reused):** `useVoiceover`, `layoutVoiceover`, `captionsFromScript`,
  `computeEffectiveAnnotationRegions`, the TTS synthesis path, the export pipeline.

## 13. Open questions (non-blocking)

- Exact `WORDS_PER_SECOND` constant and the final tone-preset wording (tune during implementation).
- Default OpenAI model id for polishing (a small, cheap chat model; pick during planning).
- Whether to expose the model choice in settings in v1 or hard-code a good default (lean:
  hard-code for v1).
- Whether a later phase persists the OpenAI key selection per profile vs. a single global key
  (v1: single global key).
