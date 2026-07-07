# AI Script Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cloud (OpenAI, bring-your-own-key) "Polish script" pass that rewrites the recorded voiceover transcript in place, per segment, so the existing on-device voiceover synthesis, linked captions, and timeline layout follow unchanged.

**Architecture:** A new `scriptPolish` native-bridge domain runs the OpenAI call in the main process (key stored via Electron `safeStorage`, never in the renderer). A renderer `useScriptPolish` hook builds a length-aware, id-keyed batch request, applies validated results into the undoable `voiceover.segments[i].text` (snapshotting `textBeforePolish` for per-segment revert), and lets the existing `computeAudioKey` → re-synthesis and `captionsFromScript` → caption derivation react for free. Pure helpers (budget math, tone presets, response validation) live in `src/lib/script/` and are unit-tested in jsdom.

**Tech Stack:** Electron (main), React + TypeScript (renderer), native-bridge IPC (`native-bridge:invoke`), Electron `safeStorage`, Node global `fetch` (Node 22), OpenAI Chat Completions, Vitest, Biome.

## Global Constraints

- Node **22.x** / npm **10.x** (`.nvmrc`, `package.json#engines`).
- Renderer (`src/`) imports via the `@/` alias — never deep relative paths. Main (`electron/`) uses **relative imports** and may import **types** from `src/` (e.g. `../../../src/native/contracts`).
- Never weaken window security: `contextIsolation: true`, `nodeIntegration: false`.
- **No preload change is needed** — the native bridge uses a single `native-bridge:invoke` channel; new domains are added in contracts + transport only.
- The OpenAI API key lives **only in the main process**, encrypted via `safeStorage`; it is never written to the renderer bundle, project JSON, or plaintext config. The renderer learns only `hasKey: boolean`.
- **v1 sends segment TEXT only** to OpenAI — never audio or video frames.
- Per-segment anchors (`sourceStartMs`/`sourceEndMs`) and the segment count **never change** during polish.
- Any user-facing string is added to **all** locale dirs under `src/i18n/locales/`; `npm run i18n:check` must pass. New polish strings extend the existing **`voiceover`** namespace (no new namespace registration).
- Production build drops `console.log`/`console.debug` — durable logs use `console.warn`/`console.error`/`console.info`, tagged `[Component]`.
- Polish is available **only when `voiceover.enabled` is true**.
- Green gates before PR: `npm run lint && npx tsc --noEmit && npm run test`. Husky runs `biome check` on commit — do not use `--no-verify`. Tests are co-located; real-Web-API code uses `*.browser.test.ts`.
- OpenAI model for v1 is hard-coded to `gpt-4o-mini` (a `SCRIPT_POLISH_MODEL` constant), tunable later.

## File Structure

**New (shared pure logic — `src/`, self-contained, no `@/` imports so nothing breaks if referenced by relative path):**
- `src/lib/script/types.ts` — request/result shapes + tone types.
- `src/lib/script/budget.ts` — `WORDS_PER_SECOND`, `computeTargetWords`.
- `src/lib/script/tonePresets.ts` — presets + `resolveToneInstruction`.
- `src/lib/script/validatePolishResults.ts` — id-set-exact validation.
- `src/lib/script/index.ts` — re-exports.

**New (main process):**
- `electron/native-bridge/services/scriptPolishService.ts` — key mgmt (safeStorage) + OpenAI fetch.
- `electron/native-bridge/services/scriptPolishService.test.ts`.

**New (renderer):**
- `src/hooks/useScriptPolish.ts` + `src/hooks/useScriptPolish.test.ts`.
- `src/components/video-editor/OpenAiKeyDialog.tsx`.

**Modified:**
- `src/lib/voiceover/types.ts` — add `textBeforePolish?`, `polishTone?`, `SegmentPolishStatus`.
- `src/components/video-editor/projectPersistence.ts` — `PROJECT_VERSION` 3→4; normalize new fields (+ test).
- `src/native/contracts.ts` — `scriptPolish` domain requests + result types.
- `src/native/client.ts` — `scriptPolish` client facade.
- `electron/ipc/nativeBridge.ts` — construct service; `case "scriptPolish"`.
- `electron/ipc/handlers.ts` — add `getScriptPolishConfigDir` to the bridge context.
- `src/components/video-editor/VoiceoverSegmentRow.tsx` — polish status/re-polish/revert.
- `src/components/video-editor/VoiceoverPanel.tsx` — tone dropdown + Polish button + no-key affordance.
- `src/components/video-editor/VideoEditor.tsx` — wire `useScriptPolish`, apply results, pass props.
- `src/i18n/locales/*/voiceover.json` — polish + key-dialog strings (all locales).
- `src/CLAUDE.md`, `electron/CLAUDE.md` — document the new `script/` lib and `scriptPolish` domain.

---

### Task 1: Shared script types, tone presets, and budget math

**Files:**
- Create: `src/lib/script/types.ts`, `src/lib/script/budget.ts`, `src/lib/script/tonePresets.ts`, `src/lib/script/index.ts`
- Test: `src/lib/script/budget.test.ts`, `src/lib/script/tonePresets.test.ts`

**Interfaces:**
- Produces: `PolishSegmentInput { id: string; text: string; targetWords: number }`; `PolishSegmentResult { id: string; text: string }`; `WORDS_PER_SECOND: number`; `computeTargetWords(sourceStartMs: number, sourceEndMs: number): number`; `TONE_PRESETS: TonePreset[]`; `DEFAULT_TONE_ID: string`; `resolveToneInstruction(toneId: string | undefined): string`; `TonePreset { id: string; labelKey: string; instruction: string }`.

- [ ] **Step 1: Write failing tests**

`src/lib/script/budget.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeTargetWords, WORDS_PER_SECOND } from "./budget";

describe("computeTargetWords", () => {
	it("scales words by spoken duration at WORDS_PER_SECOND", () => {
		expect(computeTargetWords(0, 4000)).toBe(Math.round(4 * WORDS_PER_SECOND));
	});
	it("never returns below 1 for a non-empty span", () => {
		expect(computeTargetWords(0, 100)).toBeGreaterThanOrEqual(1);
	});
	it("returns 1 for a zero/negative span (defensive)", () => {
		expect(computeTargetWords(5000, 5000)).toBe(1);
		expect(computeTargetWords(5000, 4000)).toBe(1);
	});
});
```

`src/lib/script/tonePresets.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TONE_ID, resolveToneInstruction, TONE_PRESETS } from "./tonePresets";

describe("tone presets", () => {
	it("includes the default preset id", () => {
		expect(TONE_PRESETS.some((p) => p.id === DEFAULT_TONE_ID)).toBe(true);
	});
	it("resolves a known id to its instruction", () => {
		const preset = TONE_PRESETS[0];
		expect(resolveToneInstruction(preset.id)).toBe(preset.instruction);
	});
	it("falls back to the default preset instruction for unknown/undefined", () => {
		const def = TONE_PRESETS.find((p) => p.id === DEFAULT_TONE_ID);
		expect(resolveToneInstruction(undefined)).toBe(def?.instruction);
		expect(resolveToneInstruction("does-not-exist")).toBe(def?.instruction);
	});
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/lib/script/budget.test.ts src/lib/script/tonePresets.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/lib/script/types.ts`:
```ts
/** One segment sent to the polisher: its id, current words, and a soft word budget. */
export interface PolishSegmentInput {
	id: string;
	text: string;
	targetWords: number;
}

/** One rewritten segment returned by the polisher, keyed by the input id. */
export interface PolishSegmentResult {
	id: string;
	text: string;
}

/** A project-wide tone preset. `instruction` is what the LLM actually receives. */
export interface TonePreset {
	id: string;
	/** i18n key under the `voiceover` namespace: `polish.tone.<id>`. */
	labelKey: string;
	instruction: string;
}
```

`src/lib/script/budget.ts`:
```ts
/** Approx. spoken words per second (~150 wpm). Tunable. */
export const WORDS_PER_SECOND = 2.5;

/**
 * Soft word budget for a segment, derived from its original spoken span so the
 * rewritten line stays close to the original length (natural-with-drift timing).
 * Always ≥ 1 for any positive span.
 */
export function computeTargetWords(sourceStartMs: number, sourceEndMs: number): number {
	const seconds = (sourceEndMs - sourceStartMs) / 1000;
	if (!Number.isFinite(seconds) || seconds <= 0) return 1;
	return Math.max(1, Math.round(seconds * WORDS_PER_SECOND));
}
```

`src/lib/script/tonePresets.ts`:
```ts
import type { TonePreset } from "./types";

/** Default preset: rewrites for clarity while preserving the speaker's own phrasing. */
export const DEFAULT_TONE_ID = "conversational";

export const TONE_PRESETS: TonePreset[] = [
	{
		id: "conversational",
		labelKey: "polish.tone.conversational",
		instruction:
			"Rewrite in a natural, conversational voice. Preserve the speaker's own phrasing and meaning; only remove filler words, false starts, and stumbles. Do not make it sound corporate or AI-generated.",
	},
	{
		id: "professional",
		labelKey: "polish.tone.professional",
		instruction:
			"Rewrite in a clear, professional voice suitable for a product demo. Keep it precise and confident without jargon or hype.",
	},
	{
		id: "concise",
		labelKey: "polish.tone.concise",
		instruction:
			"Rewrite as concisely as possible while preserving the meaning. Prefer short, direct sentences.",
	},
	{
		id: "enthusiastic",
		labelKey: "polish.tone.enthusiastic",
		instruction:
			"Rewrite with an upbeat, enthusiastic energy, while staying natural and not over-the-top.",
	},
	{
		id: "tutorial",
		labelKey: "polish.tone.tutorial",
		instruction:
			"Rewrite as clear step-by-step tutorial narration. Use direct instructional phrasing (e.g. 'Next, open Settings').",
	},
];

/** Resolve a preset id (or undefined) to its instruction, defaulting safely. */
export function resolveToneInstruction(toneId: string | undefined): string {
	const preset = TONE_PRESETS.find((p) => p.id === toneId);
	return (preset ?? TONE_PRESETS.find((p) => p.id === DEFAULT_TONE_ID) ?? TONE_PRESETS[0]).instruction;
}
```

`src/lib/script/index.ts`:
```ts
export * from "./budget";
export * from "./tonePresets";
export type { PolishSegmentInput, PolishSegmentResult, TonePreset } from "./types";
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/lib/script/budget.test.ts src/lib/script/tonePresets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/script/
git commit -m "feat(script-polish): add shared tone presets and word-budget math"
```

---

### Task 2: Response validation (id-set exact)

**Files:**
- Create: `src/lib/script/validatePolishResults.ts`
- Test: `src/lib/script/validatePolishResults.test.ts`
- Modify: `src/lib/script/index.ts`

**Interfaces:**
- Consumes: `PolishSegmentResult` (Task 1).
- Produces: `validatePolishResults(requestedIds: string[], raw: unknown): PolishSegmentResult[]` — returns the results in `requestedIds` order; **throws `Error`** if the response is not an array of `{id,text}` whose id-set exactly matches `requestedIds` (missing, extra, or duplicate id → throw). Guarantees no merge/split can violate the anchor invariant.

- [ ] **Step 1: Write failing test**

`src/lib/script/validatePolishResults.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validatePolishResults } from "./validatePolishResults";

const ids = ["vo-1", "vo-2"];

describe("validatePolishResults", () => {
	it("returns results ordered by requestedIds on an exact match", () => {
		const out = validatePolishResults(ids, [
			{ id: "vo-2", text: "second" },
			{ id: "vo-1", text: "first" },
		]);
		expect(out).toEqual([
			{ id: "vo-1", text: "first" },
			{ id: "vo-2", text: "second" },
		]);
	});
	it("throws on a missing id", () => {
		expect(() => validatePolishResults(ids, [{ id: "vo-1", text: "x" }])).toThrow();
	});
	it("throws on an extra id", () => {
		expect(() =>
			validatePolishResults(ids, [
				{ id: "vo-1", text: "x" },
				{ id: "vo-2", text: "y" },
				{ id: "vo-3", text: "z" },
			]),
		).toThrow();
	});
	it("throws on a duplicate id", () => {
		expect(() =>
			validatePolishResults(ids, [
				{ id: "vo-1", text: "x" },
				{ id: "vo-1", text: "y" },
			]),
		).toThrow();
	});
	it("throws when a text is missing or not a string", () => {
		expect(() =>
			validatePolishResults(ids, [
				{ id: "vo-1", text: "x" },
				{ id: "vo-2" },
			]),
		).toThrow();
	});
	it("throws when raw is not an array", () => {
		expect(() => validatePolishResults(ids, { nope: true })).toThrow();
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/script/validatePolishResults.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/script/validatePolishResults.ts`:
```ts
import type { PolishSegmentResult } from "./types";

/**
 * Validate a polish response against the exact set of requested ids. On success returns
 * the results ordered by `requestedIds`. Throws if the response is not an array of
 * `{ id, text }` whose ids exactly match (no missing, extra, or duplicate ids) — this is
 * what guarantees the per-segment anchor/count invariant can never be violated.
 */
export function validatePolishResults(requestedIds: string[], raw: unknown): PolishSegmentResult[] {
	if (!Array.isArray(raw)) {
		throw new Error("Polish response was not an array of results.");
	}
	const byId = new Map<string, string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			throw new Error("Polish response contained a non-object entry.");
		}
		const { id, text } = item as { id?: unknown; text?: unknown };
		if (typeof id !== "string" || typeof text !== "string") {
			throw new Error("Polish response entry missing string id/text.");
		}
		if (byId.has(id)) {
			throw new Error(`Polish response contained duplicate id: ${id}`);
		}
		byId.set(id, text);
	}
	if (byId.size !== requestedIds.length) {
		throw new Error(
			`Polish response id count (${byId.size}) did not match requested (${requestedIds.length}).`,
		);
	}
	return requestedIds.map((id) => {
		const text = byId.get(id);
		if (text === undefined) {
			throw new Error(`Polish response missing requested id: ${id}`);
		}
		return { id, text };
	});
}
```

Append to `src/lib/script/index.ts`:
```ts
export { validatePolishResults } from "./validatePolishResults";
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/script/validatePolishResults.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/script/
git commit -m "feat(script-polish): validate polish response against requested id set"
```

---

### Task 3: Data model — segment snapshot, tone, polish status

**Files:**
- Modify: `src/lib/voiceover/types.ts`

**Interfaces:**
- Produces: `VoiceoverSegment.textBeforePolish?: string`; `VoiceoverConfig.polishTone?: string`; `SegmentPolishStatus = { state: "idle" } | { state: "queued" } | { state: "polishing" } | { state: "error"; message: string }`.

- [ ] **Step 1: Edit types**

In `src/lib/voiceover/types.ts`, add `textBeforePolish` to `VoiceoverSegment`:
```ts
export interface VoiceoverSegment {
	id: string;
	sourceStartMs: number;
	sourceEndMs: number;
	text: string;
	/** Snapshot taken at polish time; enables one-step per-segment revert. Absent when unpolished. */
	textBeforePolish?: string;
}
```

Add `polishTone` to `VoiceoverConfig` (after `speed`):
```ts
	speed: number;
	/** Project-wide AI-polish tone preset id (see src/lib/script/tonePresets). Undefined → default. */
	polishTone?: string;
	segments: VoiceoverSegment[];
```

Add the runtime status type after `SegmentSynthStatus`:
```ts
/** Runtime (non-undoable) AI-polish status for one segment. */
export type SegmentPolishStatus =
	| { state: "idle" }
	| { state: "queued" }
	| { state: "polishing" }
	| { state: "error"; message: string };
```

`DEFAULT_VOICEOVER_CONFIG` needs no change (`polishTone` optional; defaults to undefined).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no consumers require the new optional fields yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/voiceover/types.ts
git commit -m "feat(script-polish): add segment polish snapshot, tone, and status types"
```

---

### Task 4: Project persistence — version bump + normalization

**Files:**
- Modify: `src/components/video-editor/projectPersistence.ts:69` (`PROJECT_VERSION`), `:226-249` (`normalizeVoiceoverConfig`)
- Test: `src/components/video-editor/projectPersistence.test.ts`

**Interfaces:**
- Consumes: `VoiceoverSegment.textBeforePolish`, `VoiceoverConfig.polishTone` (Task 3).
- Produces: round-trip persistence of the two new fields; `PROJECT_VERSION === 4`.

- [ ] **Step 1: Write failing test**

Add to `src/components/video-editor/projectPersistence.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeProjectEditor, PROJECT_VERSION } from "./projectPersistence";

describe("script-polish persistence", () => {
	it("PROJECT_VERSION is 4", () => {
		expect(PROJECT_VERSION).toBe(4);
	});
	it("preserves polishTone and per-segment textBeforePolish", () => {
		const editor = normalizeProjectEditor({
			voiceover: {
				enabled: true,
				engine: "kokoro-local",
				voice: "af_heart",
				speed: 1,
				polishTone: "professional",
				segments: [
					{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 2000, text: "clean", textBeforePolish: "raw" },
				],
			},
		} as never);
		expect(editor.voiceover.polishTone).toBe("professional");
		expect(editor.voiceover.segments[0].textBeforePolish).toBe("raw");
	});
	it("defaults polishTone to undefined and omits textBeforePolish for legacy projects", () => {
		const editor = normalizeProjectEditor({
			voiceover: {
				enabled: true,
				engine: "kokoro-local",
				voice: "af_heart",
				speed: 1,
				segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 2000, text: "hi" }],
			},
		} as never);
		expect(editor.voiceover.polishTone).toBeUndefined();
		expect(editor.voiceover.segments[0].textBeforePolish).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/components/video-editor/projectPersistence.test.ts -t "script-polish persistence"`
Expected: FAIL (`PROJECT_VERSION` is 3; fields dropped).

- [ ] **Step 3: Implement**

Change `src/components/video-editor/projectPersistence.ts:69`:
```ts
export const PROJECT_VERSION = 4;
```

In `normalizeVoiceoverConfig`, update the segment mapper to carry `textBeforePolish`, and add `polishTone` to the returned object. Replace the `.map((s) => ({ ... }))` body and the `return { ... }`:
```ts
			.map((s) => ({
				id: s.id,
				text: s.text,
				sourceStartMs: isFiniteNumber(s.sourceStartMs)
					? Math.max(0, Math.round(s.sourceStartMs))
					: 0,
				sourceEndMs: isFiniteNumber(s.sourceEndMs) ? Math.max(0, Math.round(s.sourceEndMs)) : 0,
				...(typeof s.textBeforePolish === "string"
					? { textBeforePolish: s.textBeforePolish }
					: {}),
			}))
		: [];
	return {
		enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_VOICEOVER_CONFIG.enabled,
		engine: VOICEOVER_ENGINE,
		voice: typeof v.voice === "string" && v.voice ? v.voice : DEFAULT_VOICEOVER_CONFIG.voice,
		speed: isFiniteNumber(v.speed) ? clamp(v.speed, 0.7, 1.2) : DEFAULT_VOICEOVER_CONFIG.speed,
		...(typeof v.polishTone === "string" ? { polishTone: v.polishTone } : {}),
		segments,
	};
```

(The `.filter((s): s is VoiceoverSegment => ...)` predicate already only requires `id`/`text`, so `textBeforePolish` passes through the filter unchanged.)

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/components/video-editor/projectPersistence.test.ts`
Expected: PASS (whole file, to catch regressions).

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/projectPersistence.ts src/components/video-editor/projectPersistence.test.ts
git commit -m "feat(script-polish): persist polishTone + textBeforePolish (project v4)"
```

---

### Task 5: Native-bridge contracts + client facade

**Files:**
- Modify: `src/native/contracts.ts` (result types + `NativeBridgeRequest` union), `src/native/client.ts` (facade)

**Interfaces:**
- Produces (contracts):
  - `ScriptPolishResult { success: boolean; results?: { id: string; text: string }[]; message?: string; code?: "no-key" | "api-error" | "invalid-response" }`
  - `ScriptPolishKeyStatus { hasKey: boolean }`
  - `ScriptPolishKeyResult { success: boolean; message?: string }`
  - Request variants (domain `"scriptPolish"`): `polish { segments: { id: string; text: string; targetWords: number }[]; toneInstruction: string }`, `getKeyStatus`, `setKey { key: string }`, `clearKey`.
- Produces (client): `nativeBridgeClient.scriptPolish.{ polish(segments, toneInstruction), getKeyStatus(), setKey(key), clearKey() }`.

- [ ] **Step 1: Add result types**

In `src/native/contracts.ts`, after `VoiceoverClipResult` (line ~114):
```ts
export interface ScriptPolishResult {
	success: boolean;
	/** Rewritten segments (id → text) when present. */
	results?: { id: string; text: string }[];
	message?: string;
	/** Machine-readable failure reason for renderer branching. */
	code?: "no-key" | "api-error" | "invalid-response";
}

export interface ScriptPolishKeyStatus {
	hasKey: boolean;
}

export interface ScriptPolishKeyResult {
	success: boolean;
	message?: string;
}
```

- [ ] **Step 2: Add request variants**

In the `NativeBridgeRequest` union, after the `voiceover` `putVoiceoverClip` variant (line ~271):
```ts
	| {
			domain: "scriptPolish";
			action: "polish";
			payload: {
				segments: { id: string; text: string; targetWords: number }[];
				toneInstruction: string;
			};
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "getKeyStatus";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "setKey";
			payload: { key: string };
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "clearKey";
			payload?: EmptyPayload;
			requestId?: string;
	  }
```

- [ ] **Step 3: Add client facade**

In `src/native/client.ts`, import the new types in the top import block:
```ts
	type ScriptPolishKeyResult,
	type ScriptPolishKeyStatus,
	type ScriptPolishResult,
```
Add a `scriptPolish` object to `nativeBridgeClient` (after `voiceover`):
```ts
	scriptPolish: {
		polish: (segments: { id: string; text: string; targetWords: number }[], toneInstruction: string) =>
			requireNativeBridgeData<ScriptPolishResult>({
				domain: "scriptPolish",
				action: "polish",
				payload: { segments, toneInstruction },
			}),
		getKeyStatus: () =>
			requireNativeBridgeData<ScriptPolishKeyStatus>({
				domain: "scriptPolish",
				action: "getKeyStatus",
			}),
		setKey: (key: string) =>
			requireNativeBridgeData<ScriptPolishKeyResult>({
				domain: "scriptPolish",
				action: "setKey",
				payload: { key },
			}),
		clearKey: () =>
			requireNativeBridgeData<ScriptPolishKeyResult>({
				domain: "scriptPolish",
				action: "clearKey",
			}),
	},
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/contracts.ts src/native/client.ts
git commit -m "feat(script-polish): add scriptPolish native-bridge contracts + client"
```

---

### Task 6: Main-process ScriptPolishService (key + OpenAI)

**Files:**
- Create: `electron/native-bridge/services/scriptPolishService.ts`
- Test: `electron/native-bridge/services/scriptPolishService.test.ts`

**Interfaces:**
- Consumes: contracts types `ScriptPolishResult`, `ScriptPolishKeyStatus`, `ScriptPolishKeyResult` (Task 5); Electron `safeStorage`; global `fetch`.
- Produces: `class ScriptPolishService` with `getKeyStatus(): Promise<ScriptPolishKeyStatus>`, `setKey(key: string): Promise<ScriptPolishKeyResult>`, `clearKey(): Promise<ScriptPolishKeyResult>`, `polish(segments, toneInstruction): Promise<ScriptPolishResult>`. Constructor: `{ configDir: string; fetchImpl?: typeof fetch; safeStorageImpl?: Pick<typeof import("electron").safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString"> }` (impls injectable for tests).

- [ ] **Step 1: Write failing test**

`electron/native-bridge/services/scriptPolishService.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptPolishService } from "./scriptPolishService";

// Fake safeStorage: reversible base64 "encryption" so we exercise the file round-trip.
const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8"),
	decryptString: (b: Buffer) => b.toString("utf8"),
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "sp-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeService(fetchImpl?: typeof fetch) {
	return new ScriptPolishService({ configDir: dir, fetchImpl, safeStorageImpl: fakeSafeStorage });
}

describe("ScriptPolishService key management", () => {
	it("reports no key initially, then set, then cleared", async () => {
		const svc = makeService();
		expect((await svc.getKeyStatus()).hasKey).toBe(false);
		await svc.setKey("sk-test");
		expect((await svc.getKeyStatus()).hasKey).toBe(true);
		await svc.clearKey();
		expect((await svc.getKeyStatus()).hasKey).toBe(false);
	});
});

describe("ScriptPolishService.polish", () => {
	it("returns code 'no-key' when no key is set", async () => {
		const svc = makeService();
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 5 }], "be concise");
		expect(res.success).toBe(false);
		expect(res.code).toBe("no-key");
	});

	it("sends the key + segments and returns parsed results", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(
				JSON.stringify({
					choices: [
						{ message: { content: JSON.stringify({ results: [{ id: "vo-1", text: "Polished." }] }) } },
					],
				}),
				{ status: 200 },
			),
		) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "uh hello", targetWords: 3 }], "be concise");
		expect(res.success).toBe(true);
		expect(res.results).toEqual([{ id: "vo-1", text: "Polished." }]);
		const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
		expect(String((init as RequestInit).body)).toContain("vo-1");
	});

	it("returns code 'api-error' on a non-200 response", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 3 }], "x");
		expect(res.success).toBe(false);
		expect(res.code).toBe("api-error");
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run electron/native-bridge/services/scriptPolishService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`electron/native-bridge/services/scriptPolishService.ts`:
```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ScriptPolishKeyResult,
	ScriptPolishKeyStatus,
	ScriptPolishResult,
} from "../../../src/native/contracts";

/** Hard-coded v1 model (see plan Global Constraints). */
const SCRIPT_POLISH_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const KEY_FILE = "openai-key.enc";

type SafeStorageLike = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
};

interface ScriptPolishServiceOptions {
	/** Directory for the encrypted key file (e.g. userData/script-polish). */
	configDir: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to Electron safeStorage (lazy-required). */
	safeStorageImpl?: SafeStorageLike;
}

/**
 * Runs the OpenAI script-polish call in the main process and owns the BYO API key,
 * stored encrypted via Electron safeStorage. The renderer never receives the key —
 * only `hasKey`. v1 sends segment TEXT only.
 */
export class ScriptPolishService {
	private readonly configDir: string;
	private readonly fetchImpl: typeof fetch;
	private safeStorageImpl?: SafeStorageLike;

	constructor(options: ScriptPolishServiceOptions) {
		this.configDir = options.configDir;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.safeStorageImpl = options.safeStorageImpl;
	}

	private safeStorage(): SafeStorageLike {
		if (!this.safeStorageImpl) {
			// Lazy require so tests never touch Electron.
			this.safeStorageImpl = require("electron").safeStorage as SafeStorageLike;
		}
		return this.safeStorageImpl;
	}

	private keyFile(): string {
		return path.join(this.configDir, KEY_FILE);
	}

	private async readKey(): Promise<string | null> {
		try {
			const buf = await readFile(this.keyFile());
			return this.safeStorage().decryptString(buf);
		} catch {
			return null;
		}
	}

	async getKeyStatus(): Promise<ScriptPolishKeyStatus> {
		return { hasKey: (await this.readKey()) !== null };
	}

	async setKey(key: string): Promise<ScriptPolishKeyResult> {
		try {
			const trimmed = key.trim();
			if (!trimmed) return { success: false, message: "Empty key." };
			if (!this.safeStorage().isEncryptionAvailable()) {
				return { success: false, message: "Secure storage unavailable on this system." };
			}
			await mkdir(this.configDir, { recursive: true });
			await writeFile(this.keyFile(), this.safeStorage().encryptString(trimmed));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearKey(): Promise<ScriptPolishKeyResult> {
		try {
			await rm(this.keyFile(), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async polish(
		segments: { id: string; text: string; targetWords: number }[],
		toneInstruction: string,
	): Promise<ScriptPolishResult> {
		const key = await this.readKey();
		if (!key) return { success: false, code: "no-key", message: "No OpenAI API key set." };

		const system = [
			"You rewrite screen-recording narration segments.",
			toneInstruction,
			"Rewrite each segment to roughly its targetWords budget so its spoken length stays close to the original.",
			"Return ONLY JSON: {\"results\":[{\"id\":string,\"text\":string}]} with exactly one entry per input id. Do not merge, split, add, or drop segments.",
		].join(" ");
		const user = JSON.stringify({ segments });

		let response: Response;
		try {
			response = await this.fetchImpl(OPENAI_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: SCRIPT_POLISH_MODEL,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
				}),
			});
		} catch (error) {
			return { success: false, code: "api-error", message: error instanceof Error ? error.message : String(error) };
		}

		if (!response.ok) {
			return { success: false, code: "api-error", message: `OpenAI request failed (${response.status}).` };
		}

		try {
			const body = (await response.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const content = body.choices?.[0]?.message?.content;
			if (!content) return { success: false, code: "invalid-response", message: "Empty completion." };
			const parsed = JSON.parse(content) as { results?: { id: string; text: string }[] };
			if (!Array.isArray(parsed.results)) {
				return { success: false, code: "invalid-response", message: "No results array in completion." };
			}
			return { success: true, results: parsed.results };
		} catch (error) {
			return { success: false, code: "invalid-response", message: error instanceof Error ? error.message : String(error) };
		}
	}
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run electron/native-bridge/services/scriptPolishService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/native-bridge/services/scriptPolishService.ts electron/native-bridge/services/scriptPolishService.test.ts
git commit -m "feat(script-polish): main-process OpenAI service with safeStorage key"
```

---

### Task 7: Wire the service into the native-bridge transport

**Files:**
- Modify: `electron/ipc/nativeBridge.ts` (import, `NativeBridgeContext`, construct service, `case "scriptPolish"`)
- Modify: `electron/ipc/handlers.ts:2917` (add `getScriptPolishConfigDir`)

**Interfaces:**
- Consumes: `ScriptPolishService` (Task 6); `NativeBridgeContext.getScriptPolishConfigDir` (new).

- [ ] **Step 1: Add the config-dir getter to the bridge context**

In `electron/ipc/nativeBridge.ts`, add to `NativeBridgeContext` (after `getVoiceoverCacheDir`):
```ts
	getScriptPolishConfigDir: () => string;
```

- [ ] **Step 2: Import + construct the service**

Add the import near the other service imports:
```ts
import { ScriptPolishService } from "../native-bridge/services/scriptPolishService";
```
Construct it after `voiceoverService` in `registerNativeBridgeHandlers`:
```ts
	const scriptPolishService = new ScriptPolishService({
		configDir: context.getScriptPolishConfigDir(),
	});
```

- [ ] **Step 3: Add the dispatch case**

Add a `case "scriptPolish"` block inside the `switch (request.domain)` (after the `voiceover` case):
```ts
				case "scriptPolish": {
					const action = request.action as string;
					switch (request.action) {
						case "polish":
							return createSuccessResponse(
								requestId,
								await scriptPolishService.polish(
									request.payload.segments,
									request.payload.toneInstruction,
								),
							);
						case "getKeyStatus":
							return createSuccessResponse(requestId, await scriptPolishService.getKeyStatus());
						case "setKey":
							return createSuccessResponse(
								requestId,
								await scriptPolishService.setKey(request.payload.key),
							);
						case "clearKey":
							return createSuccessResponse(requestId, await scriptPolishService.clearKey());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported scriptPolish action: ${action}`,
							);
					}
				}
```

- [ ] **Step 4: Provide the config dir at the call site**

In `electron/ipc/handlers.ts`, in the `registerNativeBridgeHandlers({ ... })` object (after `getVoiceoverCacheDir` at line ~2917):
```ts
		getScriptPolishConfigDir: () => path.join(app.getPath("userData"), "script-polish"),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/ipc/nativeBridge.ts electron/ipc/handlers.ts
git commit -m "feat(script-polish): register scriptPolish domain in native bridge"
```

---

### Task 8: `useScriptPolish` hook

**Files:**
- Create: `src/hooks/useScriptPolish.ts`
- Test: `src/hooks/useScriptPolish.test.ts`

**Interfaces:**
- Consumes: `computeTargetWords`, `resolveToneInstruction`, `validatePolishResults` (Tasks 1–2); `nativeBridgeClient.scriptPolish` (Task 5); `VoiceoverConfig`, `VoiceoverSegment`, `SegmentPolishStatus` (Task 3).
- Produces: `useScriptPolish({ config, onChange }): { statuses, hasKey, refreshKeyStatus, polishAll, polishSegment, revertSegment }` where `onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void`, `polishAll(): Promise<void>`, `polishSegment(id: string): Promise<void>`, `revertSegment(id: string): void`.

- [ ] **Step 1: Write failing test**

`src/hooks/useScriptPolish.test.ts`:
```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceoverConfig } from "@/lib/voiceover/types";

const polish = vi.fn();
const getKeyStatus = vi.fn(async () => ({ hasKey: true }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { scriptPolish: { polish, getKeyStatus } },
}));

import { useScriptPolish } from "./useScriptPolish";

function baseConfig(): VoiceoverConfig {
	return {
		enabled: true,
		engine: "kokoro-local",
		voice: "af_heart",
		speed: 1,
		polishTone: "concise",
		segments: [
			{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 2000, text: "uh hi" },
			{ id: "vo-2", sourceStartMs: 2000, sourceEndMs: 4000, text: "um bye" },
		],
	};
}

beforeEach(() => {
	polish.mockReset();
	getKeyStatus.mockClear();
});

describe("useScriptPolish", () => {
	it("applies polished text and snapshots textBeforePolish for each segment", async () => {
		polish.mockResolvedValue({
			success: true,
			results: [
				{ id: "vo-1", text: "Hi." },
				{ id: "vo-2", text: "Bye." },
			],
		});
		let cfg = baseConfig();
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		await act(async () => {
			await result.current.polishAll();
		});
		expect(cfg.segments[0]).toMatchObject({ text: "Hi.", textBeforePolish: "uh hi" });
		expect(cfg.segments[1]).toMatchObject({ text: "Bye.", textBeforePolish: "um bye" });
	});

	it("applies nothing and marks segments error on a failed/invalid response", async () => {
		polish.mockResolvedValue({ success: true, results: [{ id: "vo-1", text: "only one" }] });
		let cfg = baseConfig();
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		await act(async () => {
			await result.current.polishAll();
		});
		expect(onChange).not.toHaveBeenCalled(); // id-set mismatch → atomic no-op
		expect(result.current.statuses["vo-1"].state).toBe("error");
	});

	it("reverts a segment to its pre-polish text and clears the snapshot", () => {
		let cfg = baseConfig();
		cfg.segments[0] = { ...cfg.segments[0], text: "Hi.", textBeforePolish: "uh hi" };
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		act(() => result.current.revertSegment("vo-1"));
		expect(cfg.segments[0].text).toBe("uh hi");
		expect(cfg.segments[0].textBeforePolish).toBeUndefined();
	});

	it("surfaces no-key by reporting hasKey=false", async () => {
		getKeyStatus.mockResolvedValueOnce({ hasKey: false });
		const { result } = renderHook(() =>
			useScriptPolish({ config: baseConfig(), onChange: vi.fn() }),
		);
		await waitFor(() => expect(result.current.hasKey).toBe(false));
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/hooks/useScriptPolish.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/hooks/useScriptPolish.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { computeTargetWords, resolveToneInstruction, validatePolishResults } from "@/lib/script";
import type { SegmentPolishStatus, VoiceoverConfig } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";

export interface UseScriptPolishResult {
	statuses: Record<string, SegmentPolishStatus>;
	hasKey: boolean;
	refreshKeyStatus: () => Promise<void>;
	polishAll: () => Promise<void>;
	polishSegment: (id: string) => Promise<void>;
	revertSegment: (id: string) => void;
}

/**
 * Orchestrates AI script polishing. The script itself is undoable editor state (mutated via
 * `onChange`); per-segment polish status and the key-present flag are runtime-only. Results
 * are applied atomically (all-or-nothing) so the per-segment anchor/count invariant holds.
 */
export function useScriptPolish(params: {
	config: VoiceoverConfig;
	onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void;
}): UseScriptPolishResult {
	const { config, onChange } = params;
	const [statuses, setStatuses] = useState<Record<string, SegmentPolishStatus>>({});
	const [hasKey, setHasKey] = useState(false);

	const configRef = useRef(config);
	configRef.current = config;

	const refreshKeyStatus = useCallback(async () => {
		try {
			const { hasKey: present } = await nativeBridgeClient.scriptPolish.getKeyStatus();
			setHasKey(present);
		} catch (error) {
			console.warn("[useScriptPolish] key status failed:", error);
			setHasKey(false);
		}
	}, []);

	useEffect(() => {
		void refreshKeyStatus();
	}, [refreshKeyStatus]);

	const runPolish = useCallback(async (ids: string[]) => {
		const cfg = configRef.current;
		const targeted = cfg.segments.filter((s) => ids.includes(s.id) && s.text.trim().length > 0);
		if (targeted.length === 0) return;
		const inputs = targeted.map((s) => ({
			id: s.id,
			text: s.text,
			targetWords: computeTargetWords(s.sourceStartMs, s.sourceEndMs),
		}));
		setStatuses((prev) => {
			const next = { ...prev };
			for (const s of targeted) next[s.id] = { state: "polishing" };
			return next;
		});
		try {
			const res = await nativeBridgeClient.scriptPolish.polish(
				inputs,
				resolveToneInstruction(cfg.polishTone),
			);
			if (!res.success) {
				const message = res.code === "no-key" ? "no-key" : (res.message ?? "Polish failed.");
				if (res.code === "no-key") setHasKey(false);
				throw new Error(message);
			}
			const validated = validatePolishResults(
				inputs.map((i) => i.id),
				res.results,
			);
			const textById = new Map(validated.map((r) => [r.id, r.text]));
			onChange((prev) => ({
				...prev,
				segments: prev.segments.map((seg) => {
					const newText = textById.get(seg.id);
					if (newText === undefined) return seg;
					return { ...seg, textBeforePolish: seg.text, text: newText };
				}),
			}));
			setStatuses((prev) => {
				const next = { ...prev };
				for (const id of textById.keys()) next[id] = { state: "idle" };
				return next;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[useScriptPolish] polish failed:", message);
			setStatuses((prev) => {
				const next = { ...prev };
				for (const s of targeted) next[s.id] = { state: "error", message };
				return next;
			});
		}
	}, [onChange]);

	const polishAll = useCallback(
		() => runPolish(configRef.current.segments.map((s) => s.id)),
		[runPolish],
	);
	const polishSegment = useCallback((id: string) => runPolish([id]), [runPolish]);

	const revertSegment = useCallback(
		(id: string) => {
			onChange((prev) => ({
				...prev,
				segments: prev.segments.map((seg) => {
					if (seg.id !== id || seg.textBeforePolish === undefined) return seg;
					const { textBeforePolish, ...rest } = seg;
					return { ...rest, text: textBeforePolish };
				}),
			}));
			setStatuses((prev) => ({ ...prev, [id]: { state: "idle" } }));
		},
		[onChange],
	);

	return { statuses, hasKey, refreshKeyStatus, polishAll, polishSegment, revertSegment };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/hooks/useScriptPolish.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScriptPolish.ts src/hooks/useScriptPolish.test.ts
git commit -m "feat(script-polish): useScriptPolish hook (polish/apply/revert)"
```

---

### Task 9: OpenAI key dialog

**Files:**
- Create: `src/components/video-editor/OpenAiKeyDialog.tsx`

**Interfaces:**
- Consumes: `nativeBridgeClient.scriptPolish.{setKey,clearKey,getKeyStatus}` (Task 5); shadcn `Dialog` primitives (`@/components/ui/dialog`); `useScopedT("voiceover")`.
- Produces: `OpenAiKeyDialog({ open, hasKey, onOpenChange, onKeyStatusChange }: { open: boolean; hasKey: boolean; onOpenChange: (open: boolean) => void; onKeyStatusChange: () => void })`.

- [ ] **Step 1: Confirm the dialog primitive exists**

Run: `ls src/components/ui/dialog.tsx`
Expected: the file exists (shadcn dialog). If it does not, use the existing pattern from another dialog in `src/components/video-editor/` (e.g. `ShortcutsConfigDialog.tsx`) as the container instead.

- [ ] **Step 2: Implement the component**

`src/components/video-editor/OpenAiKeyDialog.tsx`:
```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";

export interface OpenAiKeyDialogProps {
	open: boolean;
	hasKey: boolean;
	onOpenChange: (open: boolean) => void;
	onKeyStatusChange: () => void;
}

export function OpenAiKeyDialog({ open, hasKey, onOpenChange, onKeyStatusChange }: OpenAiKeyDialogProps) {
	const t = useScopedT("voiceover");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await nativeBridgeClient.scriptPolish.setKey(value);
			if (!res.success) {
				setError(res.message ?? t("polish.keyDialog.saveError"));
				return;
			}
			setValue("");
			onKeyStatusChange();
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		try {
			await nativeBridgeClient.scriptPolish.clearKey();
			onKeyStatusChange();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("polish.keyDialog.title")}</DialogTitle>
					<DialogDescription>{t("polish.keyDialog.privacyNote")}</DialogDescription>
				</DialogHeader>
				<input
					type="password"
					value={value}
					placeholder={t("polish.keyDialog.placeholder")}
					onChange={(e) => setValue(e.target.value)}
					className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-[#34B27B]/50"
				/>
				{error ? <p className="text-xs text-red-300">{error}</p> : null}
				<DialogFooter className="gap-2">
					{hasKey ? (
						<Button type="button" variant="ghost" disabled={busy} onClick={clear}>
							{t("polish.keyDialog.clear")}
						</Button>
					) : null}
					<Button type="button" disabled={busy || value.trim().length === 0} onClick={save}>
						{t("polish.keyDialog.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (i18n keys used here are added in Task 12; `useScopedT` returns the key string if missing, so this compiles now.)

- [ ] **Step 4: Commit**

```bash
git add src/components/video-editor/OpenAiKeyDialog.tsx
git commit -m "feat(script-polish): OpenAI key dialog (set/clear via safeStorage)"
```

---

### Task 10: Segment row — polish status, re-polish, revert

**Files:**
- Modify: `src/components/video-editor/VoiceoverSegmentRow.tsx`

**Interfaces:**
- Consumes: `SegmentPolishStatus` (Task 3).
- Produces: `VoiceoverSegmentRowProps` gains `polishStatus: SegmentPolishStatus`, `canPolish: boolean`, `onPolish: () => void`, `onRevert: () => void`. A "Revert" button shows only when `segment.textBeforePolish !== undefined`; a "Polish" (re-polish) button shows when `canPolish`.

- [ ] **Step 1: Extend props + imports**

Add `Sparkles, RotateCcw` to the `lucide-react` import; import the type:
```tsx
import { Loader2, Play, RefreshCw, RotateCcw, Sparkles, Square } from "lucide-react";
import type { SegmentPolishStatus, SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
```
Add to `VoiceoverSegmentRowProps`:
```tsx
	polishStatus: SegmentPolishStatus;
	canPolish: boolean;
	onPolish: () => void;
	onRevert: () => void;
```
Destructure them in the component signature alongside the existing props.

- [ ] **Step 2: Render polish controls**

Inside the actions row (the `div` with `className="mt-1.5 flex items-center gap-1.5"`), after the existing Regenerate button, add:
```tsx
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={!canPolish || polishStatus.state === "polishing"}
					onClick={onPolish}
					className="h-7 gap-1 px-2 text-[11px]"
				>
					{polishStatus.state === "polishing" ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<Sparkles className="h-3 w-3" />
					)}
					{t("polish.repolish")}
				</Button>
				{segment.textBeforePolish !== undefined ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onRevert}
						className="h-7 gap-1 px-2 text-[11px]"
					>
						<RotateCcw className="h-3 w-3" />
						{t("polish.revert")}
					</Button>
				) : null}
```

- [ ] **Step 3: Show a polish error inline**

After the status chip `span` in the header row, add (so a failed polish is visible on the row):
```tsx
				{polishStatus.state === "error" ? (
					<span className="text-[10px] text-red-300">{t("polish.failed")}</span>
				) : null}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `VoiceoverPanel.tsx` does not yet pass the new required props. This is expected; Task 11 fixes the call site. (Do not commit yet.)

- [ ] **Step 5: Commit (with Task 11)**

Deferred — commit together with Task 11 so the tree typechecks. Proceed to Task 11.

---

### Task 11: Voiceover panel — tone dropdown, Polish button, wiring

**Files:**
- Modify: `src/components/video-editor/VoiceoverPanel.tsx`

**Interfaces:**
- Consumes: `TONE_PRESETS`, `DEFAULT_TONE_ID` (Task 1); `SegmentPolishStatus` (Task 3); `VoiceoverSegmentRow` new props (Task 10).
- Produces: `VoiceoverPanelProps` gains `polishStatuses: Record<string, SegmentPolishStatus>`, `hasOpenAiKey: boolean`, `onPolishTone: (toneId: string) => void`, `onPolishAll: () => void`, `onPolishSegment: (id: string) => void`, `onRevertSegment: (id: string) => void`, `onOpenKeyDialog: () => void`.

- [ ] **Step 1: Add imports**

```tsx
import { TONE_PRESETS, DEFAULT_TONE_ID } from "@/lib/script";
import type { SegmentPolishStatus, SegmentSynthStatus, VoiceoverConfig, VoiceoverSegment } from "@/lib/voiceover/types";
```

- [ ] **Step 2: Extend props**

Add to `VoiceoverPanelProps` and destructure in the component:
```tsx
	polishStatuses: Record<string, SegmentPolishStatus>;
	hasOpenAiKey: boolean;
	onPolishTone: (toneId: string) => void;
	onPolishAll: () => void;
	onPolishSegment: (id: string) => void;
	onRevertSegment: (id: string) => void;
	onOpenKeyDialog: () => void;
```

- [ ] **Step 3: Add a Polish section (gated on `config.enabled`)**

Immediately before the `{/* Generate all + reset */}` block, add:
```tsx
			{/* AI polish (voiceover must be enabled) */}
			{config.enabled ? (
				<div className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
					<div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
						{t("polish.sectionLabel")}
					</div>
					<Select value={config.polishTone ?? DEFAULT_TONE_ID} onValueChange={onPolishTone}>
						<SelectTrigger className="h-8 border-white/10 bg-black/20 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{TONE_PRESETS.map((preset) => (
								<SelectItem key={preset.id} value={preset.id} className="text-xs">
									{t(preset.labelKey)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{hasOpenAiKey ? (
						<Button
							type="button"
							size="sm"
							disabled={segments.length === 0 || isPolishing}
							onClick={onPolishAll}
							className="h-8 w-full gap-1.5 text-xs"
						>
							{isPolishing ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Sparkles className="h-3.5 w-3.5" />
							)}
							{t("polish.polishScript")}
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							variant="secondary"
							onClick={onOpenKeyDialog}
							className="h-8 w-full gap-1.5 text-xs"
						>
							{t("polish.addKey")}
						</Button>
					)}
				</div>
			) : null}
```
Add the `isPolishing` derived flag near `isGenerating`:
```tsx
	const isPolishing = segments.some((s) => polishStatuses[s.id]?.state === "polishing");
```

- [ ] **Step 4: Pass new props to each `VoiceoverSegmentRow`**

In the `segments.map(...)`, add to the `<VoiceoverSegmentRow .../>` props:
```tsx
								polishStatus={polishStatuses[segment.id] ?? { state: "idle" }}
								canPolish={hasOpenAiKey}
								onPolish={() => onPolishSegment(segment.id)}
								onRevert={() => onRevertSegment(segment.id)}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `VideoEditor.tsx` does not yet pass the new panel props. Expected; Task 12 fixes it. (Do not commit yet.)

- [ ] **Step 6: Commit (rows + panel together)**

```bash
git add src/components/video-editor/VoiceoverSegmentRow.tsx src/components/video-editor/VoiceoverPanel.tsx
git commit -m "feat(script-polish): tone picker, Polish button, and per-row revert UI"
```
(Typecheck still fails until Task 12 — that is fine for this intermediate UI commit; the next task restores green.)

---

### Task 12: Wire `useScriptPolish` into VideoEditor + key dialog

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx` (hook wiring ~line 345–369; `handleVoiceoverChange`; `voiceoverPanelProps` ~2517; render the dialog)

**Interfaces:**
- Consumes: `useScriptPolish` (Task 8); `OpenAiKeyDialog` (Task 9); the extended `VoiceoverPanelProps` (Task 11).

- [ ] **Step 1: Imports + hook wiring**

Add imports:
```tsx
import { useScriptPolish } from "@/hooks/useScriptPolish";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";
```
After the `useVoiceover({...})` call, wire the polish hook (it reuses `handleVoiceoverChange`, which is `pushState`-backed → undoable):
```tsx
	const {
		statuses: polishStatuses,
		hasKey: hasOpenAiKey,
		refreshKeyStatus,
		polishAll,
		polishSegment,
		revertSegment,
	} = useScriptPolish({ config: voiceover, onChange: handleVoiceoverChange });
	const [openAiKeyDialogOpen, setOpenAiKeyDialogOpen] = useState(false);
```

- [ ] **Step 2: Tone handler**

Add a handler near `handleResetVoiceoverScript`:
```tsx
	const handlePolishToneChange = useCallback(
		(toneId: string) => pushState((prev) => ({ voiceover: { ...prev.voiceover, polishTone: toneId } })),
		[pushState],
	);
```

- [ ] **Step 3: Extend `voiceoverPanelProps`**

In the `voiceoverPanelProps` object (~2517), add:
```tsx
		polishStatuses,
		hasOpenAiKey,
		onPolishTone: handlePolishToneChange,
		onPolishAll: () => void polishAll(),
		onPolishSegment: (id: string) => void polishSegment(id),
		onRevertSegment: revertSegment,
		onOpenKeyDialog: () => setOpenAiKeyDialogOpen(true),
```

- [ ] **Step 4: Render the dialog**

Where other editor dialogs are rendered (near the end of the returned JSX; e.g. alongside `ShortcutsConfigDialog`), add:
```tsx
			<OpenAiKeyDialog
				open={openAiKeyDialogOpen}
				hasKey={hasOpenAiKey}
				onOpenChange={setOpenAiKeyDialogOpen}
				onKeyStatusChange={() => void refreshKeyStatus()}
			/>
```

- [ ] **Step 5: Typecheck + full unit run**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS (all prior tests green; tree typechecks).

- [ ] **Step 6: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(script-polish): wire polish hook + key dialog into the editor"
```

---

### Task 13: i18n strings (all locales)

**Files:**
- Modify: every `src/i18n/locales/<locale>/voiceover.json`

**Interfaces:**
- Produces: a `polish` object under the `voiceover` namespace with keys used in Tasks 9–11: `sectionLabel`, `polishScript`, `repolish`, `revert`, `failed`, `addKey`, `tone.{conversational,professional,concise,enthusiastic,tutorial}`, and `keyDialog.{title,privacyNote,placeholder,save,clear,saveError}`.

- [ ] **Step 1: Enumerate locales**

Run: `ls src/i18n/locales`
Expected: 13 locale directories (`en`, plus the 12 others).

- [ ] **Step 2: Add the `polish` block to `en`**

Append to `src/i18n/locales/en/voiceover.json` (inside the top-level object):
```json
	"polish": {
		"sectionLabel": "AI script polish",
		"polishScript": "Polish script",
		"repolish": "Polish",
		"revert": "Revert",
		"failed": "Polish failed",
		"addKey": "Add OpenAI key",
		"tone": {
			"conversational": "Conversational",
			"professional": "Professional",
			"concise": "Concise",
			"enthusiastic": "Enthusiastic",
			"tutorial": "Tutorial"
		},
		"keyDialog": {
			"title": "OpenAI API key",
			"privacyNote": "Your segment text (no audio or video) is sent to OpenAI to polish the script. The key is stored securely on this device.",
			"placeholder": "sk-…",
			"save": "Save key",
			"clear": "Remove key",
			"saveError": "Could not save the key."
		}
	}
```
(Place it as a new top-level key in the JSON object — add a comma after the preceding `export` block's closing brace as needed to keep valid JSON.)

- [ ] **Step 3: Add translated `polish` blocks to the other 12 locales**

For each non-`en` locale dir, add the same `polish` object to its `voiceover.json`, translated. Use the locale's existing tone/register. (If a translation is unavailable, copy the `en` value so the key exists — `i18n:check` verifies presence, not translation quality.)

- [ ] **Step 4: Verify parity**

Run: `npm run i18n:check`
Expected: PASS for the `voiceover` namespace (no missing `polish.*` keys). Pre-existing unrelated failures in other namespaces, if any, are out of scope — confirm no NEW `voiceover` failures were introduced.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/locales
git commit -m "i18n(script-polish): add polish + key-dialog strings to all locales"
```

---

### Task 14: End-to-end verification + docs

**Files:**
- Modify: `src/CLAUDE.md` (mention `lib/script/`), `electron/CLAUDE.md` (add `scriptPolish` to native-bridge domains)

- [ ] **Step 1: Full gate**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: all PASS.

- [ ] **Step 2: Manual smoke test (dev)**

Run: `npm run dev`. Then:
1. Open/record a video with speech; wait for the transcript; enable **Voiceover**.
2. Confirm the **AI script polish** section appears; with no key it shows **Add OpenAI key** → opens the dialog; paste a real key, Save.
3. Pick a tone; click **Polish script**. Confirm segment texts change and each polished row shows a **Revert** control.
4. Click **Generate all** → confirm the new text re-synthesizes (changed `audioKey`), and linked captions reflect the new words.
5. Click **Revert** on one segment → its text returns to the pre-polish value; Undo (Cmd/Ctrl+Z) reverts the whole polish pass.
6. Toggle Voiceover off → the polish section disappears.

Expected: all behaviors as described; no console errors tagged `[useScriptPolish]`/`[ScriptPolishService]`.

- [ ] **Step 3: Update docs**

In `src/CLAUDE.md`, in the `lib/` bullet, add a mention of `script/` (OpenAI script-polish pure helpers: budget math, tone presets, response validation). In `electron/CLAUDE.md`, add `scriptPolish` to the list of native-bridge domains (main-process OpenAI call + safeStorage-backed BYO key).

- [ ] **Step 4: Commit**

```bash
git add src/CLAUDE.md electron/CLAUDE.md
git commit -m "docs(script-polish): note script lib + scriptPolish bridge domain"
```

---

## Self-Review

**Spec coverage** (spec `2026-07-07-ai-script-polish-design.md`):
- §3 Decision 1 (transcript-only) — Task 8 polishes existing `voiceover.segments`. ✓
- §3 Decision 2 (in-place, anchors/count fixed) — Task 2 id-set validation + Task 8 atomic map preserving ids/anchors. ✓
- §3 Decision 3 (natural-with-drift, length-aware) — Task 1 `computeTargetWords`; no timing code touched (reuses `layoutVoiceover`). ✓
- §3 Decision 4 (apply-all + per-segment revert + re-polish, undoable) — Task 8 `polishAll`/`polishSegment`/`revertSegment` via `handleVoiceoverChange` (pushState). ✓
- §3 Decision 5 (presets, project-wide) — Task 1 presets; Task 12 `polishTone` in `voiceover` config. ✓
- §3 Decision 6/7 (OpenAI cloud-only, BYO key, main process, safeStorage) — Task 6. ✓
- §3 Decision 8 (requires voiceover enabled) — Task 11 gates the section on `config.enabled`. ✓
- §6 data model — Tasks 3–4. §5 architecture / §12 components — Tasks 5–8, 10–12. §9 BYO-key & privacy — Tasks 6, 9, 13 (privacyNote). §10 error handling — Tasks 6 (codes), 8 (atomic + error status), 11 (no-key affordance). §11 testing — unit coverage in Tasks 1,2,4,6,8; manual E2E in Task 14.
- **Deviation (noted):** spec §11 suggested a new `scriptPolish` i18n namespace; the plan extends the existing `voiceover` namespace (all UI lives in the voiceover panel, avoiding a `config.ts` namespace registration). Functionally equivalent; parity still verified via `i18n:check`.
- **Refinement (noted):** after polish, changed segments become **stale/idle** and are re-synthesized via the existing explicit **Generate all** (matching the locked "explicit generation" model); the spec's "re-synthesize … automatically" means the cache/derivation react to the new text, not that synthesis auto-fires.

**Placeholder scan:** No TBD/TODO; every code step has complete code; no "add error handling" hand-waves (error codes + atomic behavior are concrete).

**Type consistency:** `PolishSegmentInput`/`PolishSegmentResult`, `ScriptPolishResult.code` union (`no-key|api-error|invalid-response`), `SegmentPolishStatus`, and the `nativeBridgeClient.scriptPolish` method names are used identically across Tasks 1, 2, 5, 6, 8, 10, 11. `handleVoiceoverChange`/`pushState`/`commitState` match the existing VideoEditor names.
