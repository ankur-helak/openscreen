# Link Captions to the Voiceover Script — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When AI voiceover is on, make the voiceover script the single source of truth for caption words + timing, style all captions with one global caption style, and collapse the redundant caption timeline lane — while leaving voiceover-off captions working as before.

**Architecture:** A pure function derives caption `AnnotationRegion[]` from the ready voiceover segments (source-time anchor + TTS-clip duration, chunked by the existing word-bounds splitter). A second pure function computes `effectiveAnnotationRegions` — swapping the derived captions in for stored `auto-caption` regions when "linked", or applying the global caption style to stored captions when not. `VideoEditor` feeds `effectiveAnnotationRegions` to both preview and export. A new `captions` slice on `EditorState` holds the global caption style + min/max words.

**Tech Stack:** React + TypeScript renderer; Vitest (jsdom) unit tests; `@/` import alias; Biome lint/format; existing captioning (`splitMergedCaptionsByWordBounds`) and voiceover (`layoutVoiceover`, types) libs.

## Global Constraints

- **Imports:** renderer code imports via the `@/*` alias, never deep relative paths.
- **Types:** `interface` for object shapes, `type` for unions; no `enum`; avoid `any`.
- **Annotation time-base:** annotation `startMs`/`endMs` are **SOURCE time** in both preview and export. Derived captions MUST be authored in source time (anchor = `sourceStartMs`, length = TTS `durationMs`). Do NOT use `layoutVoiceover` output-time `startMs` for captions.
- **i18n:** any new user-facing string goes in every locale under `src/i18n/locales/`, verified with `npm run i18n:check`.
- **Green gates before PR:** `npm run lint && npx tsc --noEmit && npm run test` (add `npm run test:browser` if export/render code changed).
- **Commits:** conventional commits; end message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work stays on branch `feat/link-captions-to-voiceover`.
- **Decisions (from spec):** captions & voiceover are independent toggles; linked only when voiceover on + captions present + ≥1 ready clip; one global caption style; caption text edited via the script while linked; ungenerated segments get no caption; voiceover-off reverts to stored captions.

---

### Task 1: Add `CaptionSettings` type + defaults; reuse in caption constants

**Files:**
- Modify: `src/components/video-editor/types.ts` (add type + defaults near the annotation defaults, ~line 287–325)
- Modify: `src/lib/captioning/annotationsFromCaptions.ts:5-26` (use the shared defaults)
- Test: `src/components/video-editor/captionSettings.test.ts` (create)

**Interfaces:**
- Produces: `interface CaptionSettings { style: AnnotationTextStyle; position: AnnotationPosition; size: AnnotationSize; minWords: number; maxWords: number }` and `DEFAULT_CAPTION_SETTINGS: CaptionSettings`, both exported from `types.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/video-editor/captionSettings.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "./types";

describe("DEFAULT_CAPTION_SETTINGS", () => {
	it("matches the legacy auto-caption look and default word bounds", () => {
		expect(DEFAULT_CAPTION_SETTINGS.style.fontSize).toBe(24);
		expect(DEFAULT_CAPTION_SETTINGS.style.fontFamily).toBe("Inter");
		expect(DEFAULT_CAPTION_SETTINGS.style.textAlign).toBe("center");
		expect(DEFAULT_CAPTION_SETTINGS.position).toEqual({ x: 4, y: 86 });
		expect(DEFAULT_CAPTION_SETTINGS.size).toEqual({ width: 92, height: 12 });
		expect(DEFAULT_CAPTION_SETTINGS.minWords).toBe(2);
		expect(DEFAULT_CAPTION_SETTINGS.maxWords).toBe(7);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/video-editor/captionSettings.test.ts`
Expected: FAIL — `DEFAULT_CAPTION_SETTINGS` is not exported.

- [ ] **Step 3: Add the type + defaults to `types.ts`**

Add after `DEFAULT_ANNOTATION_STYLE` (currently ends at line 325):

```ts
/** Global caption look + granularity. One style for ALL captions (Decision 5). */
export interface CaptionSettings {
	style: AnnotationTextStyle;
	position: AnnotationPosition;
	size: AnnotationSize;
	/** Min/Max words per caption line (the Auto-captions dialog values, now persisted). */
	minWords: number;
	maxWords: number;
}

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
	style: {
		color: "#ffffff",
		backgroundColor: "rgba(255, 255, 255, 0)",
		fontSize: 24,
		fontFamily: "Inter",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
		textAnimation: "none",
	},
	position: { x: 4, y: 86 },
	size: { width: 92, height: 12 },
	minWords: 2,
	maxWords: 7,
};
```

- [ ] **Step 4: Point the caption constants in `annotationsFromCaptions.ts` at the shared default**

Replace the local `CAPTION_STYLE` / `CAPTION_POSITION` / `CAPTION_SIZE` definitions (`annotationsFromCaptions.ts:5-26`) so they derive from the shared default (keeps one source of truth; `captionSegmentsToAnnotationRegions` behavior is unchanged):

```ts
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";

const CAPTION_POSITION = { ...DEFAULT_CAPTION_SETTINGS.position };
const CAPTION_SIZE = { ...DEFAULT_CAPTION_SETTINGS.size };
const CAPTION_STYLE: AnnotationTextStyle = { ...DEFAULT_CAPTION_SETTINGS.style };
```

(Delete the now-unused `CAPTION_WIDTH`/`CAPTION_HEIGHT`/`CAPTION_BOTTOM_MARGIN` if nothing else references them; grep first.)

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/components/video-editor/captionSettings.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/video-editor/types.ts src/lib/captioning/annotationsFromCaptions.ts src/components/video-editor/captionSettings.test.ts
git commit -m "feat(captions): add global CaptionSettings type + defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `captions` slice to `EditorState` + project-load normalization

**Files:**
- Modify: `src/hooks/useEditorHistory.ts:29-81` (add field + initial value)
- Modify: `src/components/video-editor/projectPersistence.ts` (default `captions` when loading a legacy project)
- Test: `src/hooks/useEditorHistory.test.ts` (create or extend)

**Interfaces:**
- Consumes: `CaptionSettings`, `DEFAULT_CAPTION_SETTINGS` (Task 1).
- Produces: `EditorState.captions: CaptionSettings`, present in `INITIAL_EDITOR_STATE`.

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useEditorHistory.test.ts
import { describe, expect, it } from "vitest";
import { INITIAL_EDITOR_STATE } from "./useEditorHistory";
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";

describe("INITIAL_EDITOR_STATE.captions", () => {
	it("defaults to the global caption settings", () => {
		expect(INITIAL_EDITOR_STATE.captions).toEqual(DEFAULT_CAPTION_SETTINGS);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useEditorHistory.test.ts`
Expected: FAIL — `captions` is `undefined`.

- [ ] **Step 3: Add the field + initial value**

In `useEditorHistory.ts`: import the type/default, add to the interface after `voiceover` (line 55), and to `INITIAL_EDITOR_STATE` after `voiceover` (line 80):

```ts
// with the other type imports
import type { CaptionSettings } from "@/components/video-editor/types";
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";

// in interface EditorState, after `voiceover: VoiceoverConfig;`
	/** Global caption style + word bounds (one style for all captions). */
	captions: CaptionSettings;

// in INITIAL_EDITOR_STATE, after `voiceover: DEFAULT_VOICEOVER_CONFIG,`
	captions: DEFAULT_CAPTION_SETTINGS,
```

- [ ] **Step 4: Normalize on project load (legacy projects have no `captions`)**

In `projectPersistence.ts`, find where a loaded project object is mapped into `EditorState` (grep: `grep -n "annotationRegions\|voiceover" src/components/video-editor/projectPersistence.ts`). At that deserialization site, default the field:

```ts
captions: loaded.captions ?? DEFAULT_CAPTION_SETTINGS,
```

Import `DEFAULT_CAPTION_SETTINGS` from `@/components/video-editor/types`. Ensure the serialized-out path includes `captions` (it will if it spreads the full `EditorState`; verify).

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/hooks/useEditorHistory.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors (a missing `captions` in any `EditorState` literal will surface here — fix each by adding `captions: DEFAULT_CAPTION_SETTINGS`).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useEditorHistory.ts src/components/video-editor/projectPersistence.ts src/hooks/useEditorHistory.test.ts
git commit -m "feat(captions): persist global caption settings in editor state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure `captionRegionsFromScript()` — derive captions from the script

**Files:**
- Create: `src/lib/voiceover/captionsFromScript.ts`
- Test: `src/lib/voiceover/captionsFromScript.test.ts`

**Interfaces:**
- Consumes: `VoiceoverSegment`, `SegmentSynthStatus` (`@/lib/voiceover/types`); `splitMergedCaptionsByWordBounds` (`@/lib/captioning/annotationsFromCaptions`); `AnnotationRegion`, `AnnotationTextStyle`, `AnnotationPosition`, `AnnotationSize` (`@/components/video-editor/types`).
- Produces: `captionRegionsFromScript(input: CaptionsFromScriptInput): AnnotationRegion[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/voiceover/captionsFromScript.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";
import { captionRegionsFromScript } from "./captionsFromScript";
import type { SegmentSynthStatus, VoiceoverSegment } from "./types";

const seg = (id: string, startMs: number, text: string): VoiceoverSegment => ({
	id,
	sourceStartMs: startMs,
	sourceEndMs: startMs + 1000,
	text,
});
const ready = (durationMs: number): SegmentSynthStatus => ({ state: "ready", audioKey: "k", durationMs });

const base = {
	minWords: DEFAULT_CAPTION_SETTINGS.minWords,
	maxWords: DEFAULT_CAPTION_SETTINGS.maxWords,
	style: DEFAULT_CAPTION_SETTINGS.style,
	position: DEFAULT_CAPTION_SETTINGS.position,
	size: DEFAULT_CAPTION_SETTINGS.size,
};

describe("captionRegionsFromScript", () => {
	it("anchors captions in SOURCE time using the segment start + TTS duration", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 5000, "hello world")],
			statuses: { "vo-1": ready(2000) },
			...base,
		});
		expect(regions.length).toBeGreaterThan(0);
		expect(regions[0]!.startMs).toBe(5000); // sourceStartMs, NOT an output-time value
		expect(regions.at(-1)!.endMs).toBeLessThanOrEqual(7000); // <= start + durationMs
		expect(regions[0]!.annotationSource).toBe("auto-caption");
		expect(regions[0]!.style.fontSize).toBe(24);
	});

	it("skips segments with no generated clip", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 0, "generated"), seg("vo-2", 3000, "not generated")],
			statuses: { "vo-1": ready(1500) }, // vo-2 missing
			...base,
		});
		expect(regions.every((r) => r.content !== "not generated")).toBe(true);
		expect(regions.some((r) => r.content.includes("generated"))).toBe(true);
	});

	it("clamps a long clip so it never overlaps the next segment's anchor", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 0, "one"), seg("vo-2", 1000, "two")],
			statuses: { "vo-1": ready(5000), "vo-2": ready(500) }, // vo-1 would run to 5000
			...base,
		});
		const first = regions.filter((r) => r.content === "one");
		expect(first.at(-1)!.endMs).toBeLessThanOrEqual(1000); // clamped before vo-2 @ 1000
	});

	it("returns nothing when no segment is ready", () => {
		expect(
			captionRegionsFromScript({ segments: [seg("vo-1", 0, "x")], statuses: {}, ...base }),
		).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/voiceover/captionsFromScript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/voiceover/captionsFromScript.ts
import type {
	AnnotationPosition,
	AnnotationRegion,
	AnnotationSize,
	AnnotationTextStyle,
} from "@/components/video-editor/types";
import { splitMergedCaptionsByWordBounds } from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import type { SegmentSynthStatus, VoiceoverSegment } from "./types";

export interface CaptionsFromScriptInput {
	segments: VoiceoverSegment[];
	statuses: Record<string, SegmentSynthStatus>;
	minWords: number;
	maxWords: number;
	style: AnnotationTextStyle;
	position: AnnotationPosition;
	size: AnnotationSize;
}

/** Guard so a clamped caption ends just before the next segment's source anchor. */
const OVERLAP_GUARD_MS = 1;

/**
 * Derives on-screen caption regions from the voiceover script. Captions are authored in
 * SOURCE time (the base the annotation renderers read): anchored at each ready segment's
 * `sourceStartMs`, with length = its TTS clip duration, clamped to not overlap the next
 * segment. Words are chunked by the existing caption word-bounds splitter. Ungenerated
 * segments produce no caption.
 */
export function captionRegionsFromScript(input: CaptionsFromScriptInput): AnnotationRegion[] {
	const { segments, statuses, minWords, maxWords, style, position, size } = input;

	const ready = segments
		.filter((s) => statuses[s.id]?.state === "ready")
		.sort((a, b) => a.sourceStartMs - b.sourceStartMs);

	const merged: CaptionSegment[] = [];
	for (let i = 0; i < ready.length; i++) {
		const seg = ready[i]!;
		const status = statuses[seg.id]!;
		if (status.state !== "ready") continue; // narrows the union to read durationMs
		const startMs = seg.sourceStartMs;
		let endMs = seg.sourceStartMs + status.durationMs;
		const next = ready[i + 1];
		if (next && endMs > next.sourceStartMs - OVERLAP_GUARD_MS) {
			endMs = next.sourceStartMs - OVERLAP_GUARD_MS;
		}
		const text = seg.text.trim();
		if (!text || endMs <= startMs) continue;
		merged.push({ startSec: startMs / 1000, endSec: endMs / 1000, text });
	}

	const lines = splitMergedCaptionsByWordBounds(merged, minWords, maxWords);

	return lines.map((line, index) => {
		const startMs = Math.round(line.startSec * 1000);
		const endMs = Math.max(Math.round(line.endSec * 1000), startMs + 1);
		return {
			id: `vo-caption-${index}`,
			startMs,
			endMs,
			type: "text",
			content: line.text,
			textContent: line.text,
			position: { ...position },
			size: { ...size },
			style: { ...style },
			zIndex: 0,
			annotationSource: "auto-caption",
		};
	});
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/lib/voiceover/captionsFromScript.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceover/captionsFromScript.ts src/lib/voiceover/captionsFromScript.test.ts
git commit -m "feat(captions): derive caption regions from the voiceover script

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Pure `computeEffectiveAnnotationRegions()` — swap / restyle

**Files:**
- Modify: `src/lib/voiceover/captionsFromScript.ts` (add the function)
- Test: `src/lib/voiceover/captionsFromScript.test.ts` (extend)

**Interfaces:**
- Produces: `computeEffectiveAnnotationRegions(input: EffectiveInput): AnnotationRegion[]`.

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```ts
import { computeEffectiveAnnotationRegions } from "./captionsFromScript";
import type { AnnotationRegion } from "@/components/video-editor/types";

const region = (id: string, source?: "auto-caption"): AnnotationRegion => ({
	id, startMs: 0, endMs: 1000, type: "text", content: id, textContent: id,
	position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
	style: { ...DEFAULT_CAPTION_SETTINGS.style, fontSize: 99 },
	zIndex: 0, annotationSource: source,
});

describe("computeEffectiveAnnotationRegions", () => {
	const styleArgs = {
		style: DEFAULT_CAPTION_SETTINGS.style,
		position: DEFAULT_CAPTION_SETTINGS.position,
		size: DEFAULT_CAPTION_SETTINGS.size,
	};

	it("linked: replaces stored auto-captions with derived, keeps other annotations", () => {
		const arrow = region("arrow-1");
		const storedCaption = region("annotation-1", "auto-caption");
		const derived = [region("vo-caption-0", "auto-caption")];
		const out = computeEffectiveAnnotationRegions({
			annotationRegions: [arrow, storedCaption], linked: true, derivedCaptions: derived, ...styleArgs,
		});
		expect(out.map((r) => r.id)).toEqual(["arrow-1", "vo-caption-0"]);
	});

	it("not linked: applies the global caption style to stored auto-captions only", () => {
		const arrow = region("arrow-1");
		const storedCaption = region("annotation-1", "auto-caption");
		const out = computeEffectiveAnnotationRegions({
			annotationRegions: [arrow, storedCaption], linked: false, derivedCaptions: [], ...styleArgs,
		});
		expect(out.find((r) => r.id === "annotation-1")!.style.fontSize).toBe(24); // restyled
		expect(out.find((r) => r.id === "arrow-1")!.style.fontSize).toBe(99); // untouched
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/voiceover/captionsFromScript.test.ts`
Expected: FAIL — `computeEffectiveAnnotationRegions` not exported.

- [ ] **Step 3: Implement (append to `captionsFromScript.ts`)**

```ts
export interface EffectiveInput {
	annotationRegions: AnnotationRegion[];
	linked: boolean;
	derivedCaptions: AnnotationRegion[];
	style: AnnotationTextStyle;
	position: AnnotationPosition;
	size: AnnotationSize;
}

/**
 * The annotation set that preview + export should render.
 * - linked (voiceover on + captions on + ≥1 ready clip): stored auto-captions are replaced
 *   by the script-derived captions; all other annotations pass through.
 * - not linked: stored auto-captions get the global caption style applied (so styling is
 *   consistent across voiceover on/off) WITHOUT mutating stored state.
 */
export function computeEffectiveAnnotationRegions(input: EffectiveInput): AnnotationRegion[] {
	const { annotationRegions, linked, derivedCaptions, style, position, size } = input;
	if (linked) {
		const nonCaption = annotationRegions.filter((r) => r.annotationSource !== "auto-caption");
		return [...nonCaption, ...derivedCaptions];
	}
	return annotationRegions.map((r) =>
		r.annotationSource === "auto-caption"
			? { ...r, style: { ...style }, position: { ...position }, size: { ...size } }
			: r,
	);
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/lib/voiceover/captionsFromScript.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceover/captionsFromScript.ts src/lib/voiceover/captionsFromScript.test.ts
git commit -m "feat(captions): compute effective annotation regions (swap/restyle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire derived + effective regions into `VideoEditor` (preview + export)

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx` (memos near 366–397; export configs 2056/2161)

**Interfaces:**
- Consumes: `captionRegionsFromScript`, `computeEffectiveAnnotationRegions` (Task 3/4); `state.captions` (Task 2); `voiceover`, `voiceoverStatuses`, `annotationRegions` (already in scope).
- Produces: `effectiveAnnotationRegions` used by `annotationOnlyRegions` (preview) and both exporters.

- [ ] **Step 1: Add imports**

Add to the top imports of `VideoEditor.tsx`:

```ts
import { captionRegionsFromScript, computeEffectiveAnnotationRegions } from "@/lib/voiceover/captionsFromScript";
```

- [ ] **Step 2: Add derived captions + effective regions memos (place just above the existing `annotationOnlyRegions` memo at line 390)**

`captions` is destructured from editor state alongside `voiceover` (add `captions` to that destructure at ~line 213 if not already present).

```ts
const derivedVoiceoverCaptions = useMemo(() => {
	if (!voiceover.enabled) return [];
	const hasCaptions = annotationRegions.some((r) => r.annotationSource === "auto-caption");
	if (!hasCaptions) return [];
	return captionRegionsFromScript({
		segments: voiceover.segments,
		statuses: voiceoverStatuses,
		minWords: captions.minWords,
		maxWords: captions.maxWords,
		style: captions.style,
		position: captions.position,
		size: captions.size,
	});
}, [voiceover.enabled, voiceover.segments, voiceoverStatuses, annotationRegions, captions]);

const captionsLinked =
	voiceover.enabled &&
	derivedVoiceoverCaptions.length > 0 &&
	annotationRegions.some((r) => r.annotationSource === "auto-caption");

const effectiveAnnotationRegions = useMemo(
	() =>
		computeEffectiveAnnotationRegions({
			annotationRegions,
			linked: captionsLinked,
			derivedCaptions: derivedVoiceoverCaptions,
			style: captions.style,
			position: captions.position,
			size: captions.size,
		}),
	[annotationRegions, captionsLinked, derivedVoiceoverCaptions, captions],
);
```

- [ ] **Step 3: Derive the preview/export splits from `effectiveAnnotationRegions`**

Change the split memos (currently line 390/394) to read from `effectiveAnnotationRegions`:

```ts
const annotationOnlyRegions = useMemo(
	() => effectiveAnnotationRegions.filter((r) => r.type !== "blur"),
	[effectiveAnnotationRegions],
);
const blurRegions = useMemo(
	() => effectiveAnnotationRegions.filter((r) => r.type === "blur"),
	[effectiveAnnotationRegions],
);
```

(Preview at line 2763 already passes `annotationRegions={annotationOnlyRegions}` — no change needed there.)

- [ ] **Step 4: Feed the exporters the effective regions**

At the GIF exporter config (`annotationRegions,` field, ~line 2056) and the MP4 exporter config (~line 2161), replace the shorthand with:

```ts
annotationRegions: effectiveAnnotationRegions,
```

Add `effectiveAnnotationRegions` to `handleExport`'s dependency array (currently lists `annotationRegions` at ~line 2262 — replace/append).

- [ ] **Step 5: Typecheck + full unit tests**

Run: `npx tsc --noEmit && npm run test`
Expected: no type errors; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(captions): render script-derived captions in preview + export

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Persist Auto-captions min/max words into `state.captions`

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx` (dialog state ~385–387, generate call ~2367–2453, dialog JSX ~2544–2621)

**Interfaces:**
- Consumes: `state.captions.minWords/maxWords`; `updateState`/`pushState`.

- [ ] **Step 1: Seed the dialog controls from persisted settings**

Change the transient defaults (lines 386–387) to initialize from state:

```ts
const [captionWordsMin, setCaptionWordsMin] = useState(captions.minWords);
const [captionWordsMax, setCaptionWordsMax] = useState(captions.maxWords);
```

- [ ] **Step 2: Persist min/max on Generate**

In the dialog's Generate `onClick` (~line 2608), persist before generating so the derived-caption projection uses the same bounds:

```ts
onClick={() => {
	setShowAutoCaptionsDialog(false);
	pushState((prev) => ({
		captions: { ...prev.captions, minWords: captionWordsMin, maxWords: captionWordsMax },
	}));
	void generateAutoCaptions(captionWordsMin, captionWordsMax);
}}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual check**

Run the app (see Task 9 harness). Open Auto captions, set min 3 / max 5, Generate. Reopen the dialog — it should show 3/5. Enable voiceover with generated clips — derived captions should chunk at 3–5 words.

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(captions): persist auto-caption word bounds in editor state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: One timeline row — hide the caption lane when linked

**Files:**
- Modify: `src/components/video-editor/timeline/TimelineEditor.tsx` (and/or the annotation-lane component it renders)
- Modify: `src/components/video-editor/VideoEditor.tsx` (pass a `captionsLinked` prop to the timeline if not already available)

**Interfaces:**
- Consumes: `captionsLinked` (Task 5); the annotation-lane's region list.

- [ ] **Step 1: Locate the annotation lane's region source**

Run: `grep -n "annotationSource\|auto-caption\|annotationRegions" src/components/video-editor/timeline/*.tsx`
Identify where the annotation lane maps regions (it renders per-annotation clips).

- [ ] **Step 2: Filter auto-caption regions out of the lane when linked**

Where the timeline builds its annotation-lane items, exclude auto-caption regions when `captionsLinked` (they are represented by the voiceover lane):

```ts
const laneAnnotations = captionsLinked
	? annotationRegions.filter((r) => r.annotationSource !== "auto-caption")
	: annotationRegions;
```

Thread `captionsLinked` from `VideoEditor` to the timeline via the existing timeline props object (the voiceover props are already passed near line 3047–3051 — add `captionsLinked` alongside).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual check**

With voiceover on + captions generated + clips ready: the timeline shows the voiceover lane but NOT a separate lane full of caption chunks. Turn voiceover off: the caption chunks reappear in the annotation lane.

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/timeline/ src/components/video-editor/VideoEditor.tsx
git commit -m "feat(captions): collapse the caption lane into the voiceover lane when linked

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Caption styling edits the global caption style

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx` (`handleAnnotationStyleChange` ~1678–1694; selected-annotation lookup)

**Interfaces:**
- Consumes: `state.captions`; `effectiveAnnotationRegions` (for selecting derived captions).
- Produces: caption style edits write to `state.captions.style` (global).

- [ ] **Step 1: Make the selected-annotation lookup see derived captions**

Find where `selectedAnnotation` is resolved (grep: `grep -n "selectedAnnotationId" src/components/video-editor/VideoEditor.tsx`). Resolve it from `effectiveAnnotationRegions` so a selected `vo-caption-*` (derived) region is found:

```ts
const selectedAnnotation = effectiveAnnotationRegions.find((r) => r.id === selectedAnnotationId) ?? null;
```

- [ ] **Step 2: Route caption style edits to the global style**

In `handleAnnotationStyleChange` (line 1678), branch first on caption-ness so both stored auto-captions and derived `vo-caption-*` regions update the one global style:

```ts
const handleAnnotationStyleChange = useCallback(
	(id: string, stylePatch: Partial<AnnotationRegion["style"]>) => {
		const isCaption =
			id.startsWith("vo-caption-") ||
			annotationRegions.find((r) => r.id === id)?.annotationSource === "auto-caption";
		if (isCaption) {
			pushState((prev) => ({
				captions: { ...prev.captions, style: { ...prev.captions.style, ...stylePatch } },
			}));
			return;
		}
		// ...existing per-annotation style path (unchanged)...
	},
	[annotationRegions, pushState /* plus existing deps */],
);
```

(Keep the existing non-caption path exactly as-is below the early return; remove the now-redundant `syncAutoCaptions` sibling-broadcast branch since captions use the global style.)

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc --noEmit && npm run test`
Expected: no errors; tests pass.

- [ ] **Step 4: Manual check**

Select a caption (voiceover on) → the Annotation Settings panel opens with Font/Size/Animation. Change the font → ALL captions update. Turn voiceover off → captions keep the same font (global style persists across on/off).

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(captions): edit one global caption style from the annotation panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verify end-to-end, i18n, and docs

**Files:**
- Modify: `src/i18n/locales/*/*.json` (only if any new user-facing string was added)
- Modify: `src/CLAUDE.md` (note captions↔voiceover linkage in the `lib/`/`hooks/` descriptions)

- [ ] **Step 1: i18n parity (only if strings were added)**

Run: `npm run i18n:check`
Expected: PASS (no missing keys vs `en`). Add any new keys to every locale.

- [ ] **Step 2: Full gates**

Run: `npm run lint && npx tsc --noEmit && npm run test && npm run test:browser`
Expected: all green (browser tier because export/render changed).

- [ ] **Step 3: Drive the real app (adapt the screenshot-driver pattern used during review)**

Build (`npx vite build`), launch `dist-electron/main.js` via Playwright `_electron` with `HEADLESS=false`, seed a fake transcript + generate captions, enable voiceover, seed/generate clips, and screenshot. Confirm:
- Captions on screen match the script words (edit a script line → caption text follows).
- Only one timeline lane for the spoken/caption content.
- Caption font change applies to all captions and persists across voiceover off.
- Export a short clip; confirm burned-in captions are present and aligned to the voice.

- [ ] **Step 4: Update docs**

In `src/CLAUDE.md`, extend the `lib/` voiceover bullet and `hooks/` notes to mention `captionsFromScript` (script→caption projection) and the `captions` editor-state slice. Keep it one or two lines, matching the file's style.

- [ ] **Step 5: Commit**

```bash
git add src/CLAUDE.md src/i18n
git commit -m "docs(captions): note script→caption linkage; i18n parity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (coverage vs spec)

- Decision 1 (script master) → Task 3 + Task 5. Decision 2 (granularity reuse) → Task 3 (`splitMergedCaptionsByWordBounds`) + Task 6 (persist min/max). Decision 3 (independent toggles / linked condition) → Task 5 (`captionsLinked`). Decision 4 (revert on off) → Task 4 (`computeEffectiveAnnotationRegions` non-linked path; stored regions never mutated). Decision 5 (one global style) → Tasks 1, 2, 8. Decision 6 (style survives re-sync) → Tasks 4/8 (style is global state, not on derived regions). Decision 7 (words via script; style editable) → Task 8. Decision 8 (one lane) → Task 7. Decision 9 (ungenerated → no caption) → Task 3.
- Time-base constraint honored in Task 3 (source-time anchor, TTS duration only).
- Type consistency: `captionRegionsFromScript` returns `AnnotationRegion[]` (Task 3) consumed as `derivedCaptions` by `computeEffectiveAnnotationRegions` (Task 4) and `derivedVoiceoverCaptions` in `VideoEditor` (Task 5); `CaptionSettings` fields (`style`/`position`/`size`/`minWords`/`maxWords`) are used identically across Tasks 1, 2, 5, 6, 8.
