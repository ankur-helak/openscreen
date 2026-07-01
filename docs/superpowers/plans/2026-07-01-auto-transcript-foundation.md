# Auto-Transcript Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically generate, cache, and persist a video transcript on load — kept separate from editable captions — behind a modular, configurable transcription provider (Whisper default).

**Architecture:** A new renderer library `src/lib/transcription/` defines a `TranscriptionProvider` interface and a Whisper-local provider that wraps the existing `src/lib/captioning/` engine. A `useTranscript` hook orchestrates: on video load it checks a `userData` sidecar cache (via a new native-bridge `transcript` domain) and, on a miss, transcribes silently and writes the cache. `generateAutoCaptions` is refactored to reuse the stored transcript. Caption edits autosave to a `userData` draft and restore on load.

**Tech Stack:** Electron 41 (main + preload, ESM, relative imports), React + TypeScript renderer (`@/` alias), Vite, Vitest (jsdom + browser tiers), Biome, `@xenova/transformers` (whisper-tiny), native-bridge IPC.

## Global Constraints

- Renderer imports use the `@/*` alias; `electron/` uses relative imports. (coding-style §)
- Security stays locked: `contextIsolation: true`, `nodeIntegration: false`. Do not weaken.
- `interface` for object shapes, `type` for unions; no `enum`; avoid `any`.
- New native features go through the native bridge, following the existing `project` service layering: `contracts.ts` → `client.ts` → `nativeBridge.ts` (transport) → `services/*.ts` (constructor DI).
- Production strips `console.log`/`console.debug`; durable logs use `console.warn`/`.error`/`.info`, tagged `[Component]`.
- No new user-facing i18n strings in this cycle (reuse existing `autoCaptions.*` keys). If any string is added later, it must go in all locales and pass `npm run i18n:check`.
- Green gates before PR: `npm run lint && npx tsc --noEmit && npm run test`.
- Default model stays **bundled** (`Xenova/whisper-tiny`); no runtime download path is added this cycle. `preparing-model` status is derived from the worker's existing `onStatus("model")` phase.
- Transcript is **not** embedded in the project file this cycle (sidecar cache only). Edited captions persist in the project file (existing `annotationRegions`) plus a `userData` autosave draft.

---

## File Structure

**New (renderer lib):**
- `src/lib/transcription/types.ts` — `Transcript`, `TranscriptStatus`, `TranscriptionProvider`, `TranscriptionNoAudioError`.
- `src/lib/transcription/providers/whisperLocal.ts` — Whisper provider wrapping the captioning engine.
- `src/lib/transcription/config.ts` — provider registry + `getActiveProvider()`.
- `src/lib/transcription/loadPlan.ts` — pure `resolveTranscriptLoadPlan()`.
- `src/lib/transcription/index.ts` — barrel.
- Tests: `config.test.ts`, `loadPlan.test.ts` co-located.

**New (renderer hook):**
- `src/hooks/useTranscript.ts` — orchestration hook.

**New (main-process service):**
- `electron/native-bridge/services/transcriptService.ts` — fs-backed sidecar cache + caption drafts.
- Test: `electron/native-bridge/services/transcriptService.test.ts` (temp-dir based).

**Modified:**
- `src/native/contracts.ts` — add `transcript` domain request variants + result types.
- `src/native/client.ts` — add `nativeBridgeClient.transcript.*`.
- `electron/ipc/nativeBridge.ts` — instantiate `TranscriptService`, add `transcript` domain case, extend `NativeBridgeContext`.
- `electron/ipc/handlers.ts` — supply the two `userData` dirs to the bridge context.
- `src/components/video-editor/VideoEditor.tsx` — wire `useTranscript`; refactor `generateAutoCaptions`; autosave/restore caption drafts.

---

## Task 1: Transcription types, config, and Whisper provider

**Files:**
- Create: `src/lib/transcription/types.ts`
- Create: `src/lib/transcription/providers/whisperLocal.ts`
- Create: `src/lib/transcription/config.ts`
- Create: `src/lib/transcription/index.ts`
- Test: `src/lib/transcription/config.test.ts`

**Interfaces:**
- Consumes: `extractMono16kFromVideoUrl`, `MAX_CAPTION_AUDIO_SEC`, `transcribeMono16kToSegments`, `trimLeadingSilenceMono16k`, `shiftTrimRegionsMsForCaptionBuffer` (all from `@/lib/captioning`); `CaptionSegment`, `TranscribeMono16kResult` types; `TrimRegion` from `@/components/video-editor/types`.
- Produces:
  - `interface Transcript { segments: CaptionSegment[]; granularity: "word" | "phrase"; provider: string; model: string; audioDurationSec: number; truncated: boolean; createdAt: number; schemaVersion: number }`
  - `type TranscriptStatus` (union, see code).
  - `interface TranscriptionProvider { id: string; model: string; transcribe(videoUrl: string, opts: TranscribeOptions): Promise<TranscribeVideoResult> }`
  - `class TranscriptionNoAudioError extends Error`
  - `getActiveProvider(): TranscriptionProvider`
  - `TRANSCRIPT_SCHEMA_VERSION = 1`

- [ ] **Step 1: Write `src/lib/transcription/types.ts`**

```ts
import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment } from "@/lib/captioning";

/** Schema version stamped into cached transcripts so the cache can be invalidated on change. */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

/** A generated transcript: the raw speech-to-text source of truth (distinct from caption overlays). */
export interface Transcript {
	segments: CaptionSegment[];
	granularity: "word" | "phrase";
	provider: string;
	model: string;
	audioDurationSec: number;
	truncated: boolean;
	createdAt: number;
	schemaVersion: number;
}

/** UI-facing status of background transcription for the current video. */
export type TranscriptStatus =
	| { state: "idle" }
	| { state: "preparing-model" }
	| { state: "transcribing" }
	| { state: "ready"; transcript: Transcript }
	| { state: "no-speech" }
	| { state: "no-audio" }
	| { state: "error"; message: string };

export interface TranscribeOptions {
	trimRegions?: TrimRegion[];
	signal?: AbortSignal;
	onStatus?: (phase: "model" | "transcribe") => void;
}

/** Raw result a provider returns before it is wrapped into a {@link Transcript}. */
export interface TranscribeVideoResult {
	segments: CaptionSegment[];
	granularity: "word" | "phrase";
	audioDurationSec: number;
	truncated: boolean;
}

/** Thrown by a provider when the video has no usable audio to transcribe. */
export class TranscriptionNoAudioError extends Error {
	constructor(message = "No usable audio to transcribe.") {
		super(message);
		this.name = "TranscriptionNoAudioError";
	}
}

export interface TranscriptionProvider {
	/** Stable id, e.g. "whisper-local". */
	id: string;
	/** Model id, e.g. "whisper-tiny". */
	model: string;
	/** Transcribe a video URL into timed segments. Throws {@link TranscriptionNoAudioError} for no audio. */
	transcribe(videoUrl: string, opts?: TranscribeOptions): Promise<TranscribeVideoResult>;
}
```

- [ ] **Step 2: Write `src/lib/transcription/providers/whisperLocal.ts`** (moves the transcription logic currently inline in `generateAutoCaptions`)

```ts
import type { TrimRegion } from "@/components/video-editor/types";
import {
	extractMono16kFromVideoUrl,
	shiftTrimRegionsMsForCaptionBuffer,
	transcribeMono16kToSegments,
	trimLeadingSilenceMono16k,
} from "@/lib/captioning";
import {
	type TranscribeOptions,
	type TranscribeVideoResult,
	type TranscriptionProvider,
	TranscriptionNoAudioError,
} from "../types";

const MIN_SAMPLES = 800;

/** In-renderer Whisper (transformers.js) provider. Wraps extract → trim-silence → transcribe. */
export const whisperLocalProvider: TranscriptionProvider = {
	id: "whisper-local",
	model: "whisper-tiny",

	async transcribe(videoUrl: string, opts: TranscribeOptions = {}): Promise<TranscribeVideoResult> {
		const trimRegions: TrimRegion[] = opts.trimRegions ?? [];

		const { samples, truncated, durationSec } = await extractMono16kFromVideoUrl(videoUrl, {
			signal: opts.signal,
		});
		if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < MIN_SAMPLES) {
			throw new TranscriptionNoAudioError();
		}

		const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(samples);
		if (speechSamples.length < MIN_SAMPLES) {
			throw new TranscriptionNoAudioError();
		}

		const trimMs = Math.round(trimSec * 1000);
		const shiftedTrims = shiftTrimRegionsMsForCaptionBuffer(trimRegions, trimMs);

		let { segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(speechSamples, {
			trimRegions: shiftedTrims,
			signal: opts.signal,
			onStatus: opts.onStatus,
		});
		let transcribedFromTrimmedBuffer = true;

		// Leading-silence trimming can return empty even when the full source has speech.
		if (segmentsRaw.length === 0 && trimSec > 0) {
			({ segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(samples, {
				trimRegions,
				signal: opts.signal,
				onStatus: opts.onStatus,
			}));
			transcribedFromTrimmedBuffer = false;
		}

		const segments =
			transcribedFromTrimmedBuffer && trimSec > 0
				? segmentsRaw.map((s) => ({
						...s,
						startSec: s.startSec + trimSec,
						endSec: s.endSec + trimSec,
					}))
				: segmentsRaw;

		return { segments, granularity, audioDurationSec: durationSec, truncated };
	},
};
```

- [ ] **Step 3: Write `src/lib/transcription/config.ts`**

```ts
import type { TranscriptionProvider } from "./types";
import { whisperLocalProvider } from "./providers/whisperLocal";

/** Registered providers, keyed by id. Add offline/API providers here as they are implemented. */
const PROVIDERS: Record<string, TranscriptionProvider> = {
	[whisperLocalProvider.id]: whisperLocalProvider,
};

/** Id of the provider used when none is explicitly configured. */
export const DEFAULT_PROVIDER_ID = whisperLocalProvider.id;

/**
 * Returns the active transcription provider. Configuration is a constant today; a settings-driven
 * selector can override `id` later without changing callers.
 */
export function getActiveProvider(id: string = DEFAULT_PROVIDER_ID): TranscriptionProvider {
	const provider = PROVIDERS[id];
	if (!provider) {
		throw new Error(`[transcription] Unknown provider id: ${id}`);
	}
	return provider;
}

/** Ids of all registered providers (for future settings UI). */
export function listProviderIds(): string[] {
	return Object.keys(PROVIDERS);
}
```

- [ ] **Step 4: Write `src/lib/transcription/index.ts`**

```ts
export { DEFAULT_PROVIDER_ID, getActiveProvider, listProviderIds } from "./config";
export type {
	TranscribeOptions,
	TranscribeVideoResult,
	Transcript,
	TranscriptionProvider,
	TranscriptStatus,
} from "./types";
export { TRANSCRIPT_SCHEMA_VERSION, TranscriptionNoAudioError } from "./types";
export { whisperLocalProvider } from "./providers/whisperLocal";
```

- [ ] **Step 5: Write the failing test `src/lib/transcription/config.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ID, getActiveProvider, listProviderIds } from "./config";

describe("transcription config", () => {
	it("defaults to the whisper-local provider", () => {
		const provider = getActiveProvider();
		expect(provider.id).toBe(DEFAULT_PROVIDER_ID);
		expect(provider.id).toBe("whisper-local");
		expect(provider.model).toBe("whisper-tiny");
	});

	it("resolves a provider by id", () => {
		expect(getActiveProvider("whisper-local").id).toBe("whisper-local");
	});

	it("throws on an unknown provider id", () => {
		expect(() => getActiveProvider("does-not-exist")).toThrow(/Unknown provider/);
	});

	it("lists the registered provider ids", () => {
		expect(listProviderIds()).toContain("whisper-local");
	});
});
```

- [ ] **Step 6: Run the test — expect FAIL then PASS**

Run: `npx vitest run src/lib/transcription/config.test.ts`
Expected: PASS (all 4). If the provider file has a typo it will fail to import — fix and re-run.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/transcription
git commit -m "feat(transcription): add provider interface, whisper-local provider, and config"
```

---

## Task 2: Pure load-plan resolver

**Files:**
- Create: `src/lib/transcription/loadPlan.ts`
- Test: `src/lib/transcription/loadPlan.test.ts`
- Modify: `src/lib/transcription/index.ts` (export the resolver)

**Interfaces:**
- Produces:
  - `type CaptionSource = "project" | "draft" | "none"`
  - `interface TranscriptLoadPlan { captionSource: CaptionSource; needsTranscription: boolean }`
  - `resolveTranscriptLoadPlan(inputs: { hasProjectCaptions: boolean; hasCaptionDraft: boolean; hasCachedTranscript: boolean }): TranscriptLoadPlan`

- [ ] **Step 1: Write the failing test `src/lib/transcription/loadPlan.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { resolveTranscriptLoadPlan } from "./loadPlan";

describe("resolveTranscriptLoadPlan", () => {
	it("prefers project captions over everything", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: true,
			hasCaptionDraft: true,
			hasCachedTranscript: true,
		});
		expect(plan.captionSource).toBe("project");
	});

	it("falls back to an autosave draft when there are no project captions", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: false,
			hasCaptionDraft: true,
			hasCachedTranscript: false,
		});
		expect(plan.captionSource).toBe("draft");
	});

	it("uses no caption overlays when neither project nor draft captions exist", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: false,
			hasCaptionDraft: false,
			hasCachedTranscript: true,
		});
		expect(plan.captionSource).toBe("none");
	});

	it("needs transcription only when no transcript is cached", () => {
		expect(
			resolveTranscriptLoadPlan({
				hasProjectCaptions: false,
				hasCaptionDraft: false,
				hasCachedTranscript: false,
			}).needsTranscription,
		).toBe(true);
		expect(
			resolveTranscriptLoadPlan({
				hasProjectCaptions: true,
				hasCaptionDraft: false,
				hasCachedTranscript: true,
			}).needsTranscription,
		).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/transcription/loadPlan.test.ts`
Expected: FAIL with "resolveTranscriptLoadPlan is not a function" / import error.

- [ ] **Step 3: Write `src/lib/transcription/loadPlan.ts`**

```ts
/** Where the caption overlays shown on load should come from. */
export type CaptionSource = "project" | "draft" | "none";

export interface TranscriptLoadPlan {
	/** Which caption overlays to restore on load (transcript is handled separately). */
	captionSource: CaptionSource;
	/** Whether a transcript must be generated (no usable cache present). */
	needsTranscription: boolean;
}

/**
 * Pure decision for what to do when a video loads. Captions and the transcript are independent:
 * captions restore from project → draft → none; the transcript is always ensured, generating only
 * when nothing is cached.
 */
export function resolveTranscriptLoadPlan(inputs: {
	hasProjectCaptions: boolean;
	hasCaptionDraft: boolean;
	hasCachedTranscript: boolean;
}): TranscriptLoadPlan {
	const captionSource: CaptionSource = inputs.hasProjectCaptions
		? "project"
		: inputs.hasCaptionDraft
			? "draft"
			: "none";
	return { captionSource, needsTranscription: !inputs.hasCachedTranscript };
}
```

- [ ] **Step 4: Add the export to `src/lib/transcription/index.ts`** (append)

```ts
export type { CaptionSource, TranscriptLoadPlan } from "./loadPlan";
export { resolveTranscriptLoadPlan } from "./loadPlan";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/transcription/loadPlan.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/transcription/loadPlan.ts src/lib/transcription/loadPlan.test.ts src/lib/transcription/index.ts
git commit -m "feat(transcription): add pure load-plan resolver"
```

---

## Task 3: Native-bridge contracts + client for the `transcript` domain

**Files:**
- Modify: `src/native/contracts.ts`
- Modify: `src/native/client.ts`

**Interfaces:**
- Produces (contracts):
  - `interface TranscriptCacheResult { success: boolean; transcript?: unknown; message?: string }`
  - `interface CaptionDraftResult { success: boolean; regions?: unknown; message?: string }`
  - Request variants for `domain: "transcript"` actions `getTranscript`, `putTranscript`, `getCaptionDraft`, `putCaptionDraft`, `clearCaptionDraft` (all payloads keyed by `sourcePath`).
- Produces (client): `nativeBridgeClient.transcript.{ getTranscript, putTranscript, getCaptionDraft, putCaptionDraft, clearCaptionDraft }`.

- [ ] **Step 1: Add result types to `src/native/contracts.ts`** (insert after `ProjectFileResult`, before `NativeBridgeErrorCode`)

```ts
export interface TranscriptCacheResult {
	success: boolean;
	/** Serialized `Transcript` when present; `undefined`/absent on a cache miss. */
	transcript?: unknown;
	message?: string;
}

export interface CaptionDraftResult {
	success: boolean;
	/** Serialized `AnnotationRegion[]` when present; absent when no draft exists. */
	regions?: unknown;
	message?: string;
}
```

- [ ] **Step 2: Add request variants to the `NativeBridgeRequest` union in `src/native/contracts.ts`** (insert before the first `cursor` variant)

```ts
	| {
			domain: "transcript";
			action: "getTranscript";
			payload: { sourcePath: string };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "putTranscript";
			payload: { sourcePath: string; transcript: unknown };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "getCaptionDraft";
			payload: { sourcePath: string };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "putCaptionDraft";
			payload: { sourcePath: string; regions: unknown };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "clearCaptionDraft";
			payload: { sourcePath: string };
			requestId?: string;
	  }
```

- [ ] **Step 3: Import the new result types in `src/native/client.ts`** (add to the existing import block from `./contracts`)

```ts
	type CaptionDraftResult,
	type TranscriptCacheResult,
```

- [ ] **Step 4: Add the `transcript` client section in `src/native/client.ts`** (insert into the `nativeBridgeClient` object, after the `project: { ... },` block)

```ts
	transcript: {
		getTranscript: (sourcePath: string) =>
			requireNativeBridgeData<TranscriptCacheResult>({
				domain: "transcript",
				action: "getTranscript",
				payload: { sourcePath },
			}),
		putTranscript: (sourcePath: string, transcript: unknown) =>
			requireNativeBridgeData<TranscriptCacheResult>({
				domain: "transcript",
				action: "putTranscript",
				payload: { sourcePath, transcript },
			}),
		getCaptionDraft: (sourcePath: string) =>
			requireNativeBridgeData<CaptionDraftResult>({
				domain: "transcript",
				action: "getCaptionDraft",
				payload: { sourcePath },
			}),
		putCaptionDraft: (sourcePath: string, regions: unknown) =>
			requireNativeBridgeData<CaptionDraftResult>({
				domain: "transcript",
				action: "putCaptionDraft",
				payload: { sourcePath, regions },
			}),
		clearCaptionDraft: (sourcePath: string) =>
			requireNativeBridgeData<CaptionDraftResult>({
				domain: "transcript",
				action: "clearCaptionDraft",
				payload: { sourcePath },
			}),
	},
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (No handler yet — that is Task 4; the union addition compiles on its own.)

- [ ] **Step 6: Commit**

```bash
git add src/native/contracts.ts src/native/client.ts
git commit -m "feat(native-bridge): add transcript domain contracts and client"
```

---

## Task 4: Main-process transcript service + transport wiring

**Files:**
- Create: `electron/native-bridge/services/transcriptService.ts`
- Test: `electron/native-bridge/services/transcriptService.test.ts`
- Modify: `electron/ipc/nativeBridge.ts`
- Modify: `electron/ipc/handlers.ts`

**Interfaces:**
- Consumes: `context.resolveVideoPath` (existing), two new context getters for the cache/draft dirs.
- Produces: `class TranscriptService` with `getTranscript`, `putTranscript`, `getCaptionDraft`, `putCaptionDraft`, `clearCaptionDraft` returning `TranscriptCacheResult`/`CaptionDraftResult`.

- [ ] **Step 1: Write the failing test `electron/native-bridge/services/transcriptService.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptService } from "./transcriptService";

let root: string;
let videoPath: string;
let service: TranscriptService;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "transcript-svc-"));
	videoPath = path.join(root, "video.mp4");
	await writeFile(videoPath, "fake-video-bytes");
	service = new TranscriptService({
		cacheDir: path.join(root, "transcripts"),
		draftsDir: path.join(root, "caption-drafts"),
		resolveSourcePath: (p) => p,
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("TranscriptService", () => {
	it("returns success with no transcript on a cache miss", async () => {
		const res = await service.getTranscript(videoPath);
		expect(res.success).toBe(true);
		expect(res.transcript).toBeUndefined();
	});

	it("round-trips a stored transcript", async () => {
		const transcript = { segments: [{ startSec: 0, endSec: 1, text: "hi" }], model: "whisper-tiny" };
		await service.putTranscript(videoPath, transcript);
		const res = await service.getTranscript(videoPath);
		expect(res.transcript).toEqual(transcript);
	});

	it("invalidates the cache when the video bytes change", async () => {
		await service.putTranscript(videoPath, { segments: [], model: "whisper-tiny" });
		await writeFile(videoPath, "different-and-longer-bytes");
		const res = await service.getTranscript(videoPath);
		expect(res.transcript).toBeUndefined();
	});

	it("round-trips and clears a caption draft", async () => {
		const regions = [{ id: "annotation-1", type: "text", content: "hi" }];
		await service.putCaptionDraft(videoPath, regions);
		expect((await service.getCaptionDraft(videoPath)).regions).toEqual(regions);
		await service.clearCaptionDraft(videoPath);
		expect((await service.getCaptionDraft(videoPath)).regions).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/native-bridge/services/transcriptService.test.ts`
Expected: FAIL — cannot import `./transcriptService`.

- [ ] **Step 3: Write `electron/native-bridge/services/transcriptService.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptionDraftResult, TranscriptCacheResult } from "../../../src/native/contracts";

interface TranscriptServiceOptions {
	/** Directory for transcript cache files (e.g. userData/transcripts). */
	cacheDir: string;
	/** Directory for caption autosave drafts (e.g. userData/caption-drafts). */
	draftsDir: string;
	/** Normalizes a renderer-supplied source path (e.g. strips file:// ) to a real fs path. */
	resolveSourcePath: (sourcePath: string) => string | null;
}

/**
 * File-backed sidecar cache for generated transcripts, plus caption autosave drafts. Both are keyed
 * to the video by a cheap stat signature (path + size + mtime) so edits to the source invalidate
 * the cache without hashing the whole file.
 */
export class TranscriptService {
	constructor(private readonly options: TranscriptServiceOptions) {}

	private async keyFor(sourcePath: string): Promise<string> {
		const resolved = this.options.resolveSourcePath(sourcePath) ?? sourcePath;
		let signature = resolved;
		try {
			const s = await stat(resolved);
			signature = `${resolved}:${s.size}:${Math.round(s.mtimeMs)}`;
		} catch {
			// Unresolvable path — fall back to the raw string so behaviour is deterministic.
		}
		return createHash("sha1").update(signature).digest("hex");
	}

	private async readJson(dir: string, key: string): Promise<unknown | undefined> {
		try {
			const raw = await readFile(path.join(dir, `${key}.json`), "utf8");
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	private async writeJson(dir: string, key: string, value: unknown): Promise<void> {
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), "utf8");
	}

	async getTranscript(sourcePath: string): Promise<TranscriptCacheResult> {
		try {
			const key = await this.keyFor(sourcePath);
			const transcript = await this.readJson(this.options.cacheDir, key);
			return { success: true, transcript };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async putTranscript(sourcePath: string, transcript: unknown): Promise<TranscriptCacheResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await this.writeJson(this.options.cacheDir, key, transcript);
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async getCaptionDraft(sourcePath: string): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			const regions = await this.readJson(this.options.draftsDir, key);
			return { success: true, regions };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async putCaptionDraft(sourcePath: string, regions: unknown): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await this.writeJson(this.options.draftsDir, key, regions);
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearCaptionDraft(sourcePath: string): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await rm(path.join(this.options.draftsDir, `${key}.json`), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/native-bridge/services/transcriptService.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Wire the service into `electron/ipc/nativeBridge.ts`**

5a. Add to the import from `../../src/native/contracts` (extend the existing import list):

```ts
	type CaptionDraftResult,
	type TranscriptCacheResult,
```

5b. Add the service import (next to the other service imports):

```ts
import { TranscriptService } from "../native-bridge/services/transcriptService";
```

5c. Extend `NativeBridgeContext` (add these fields to the interface):

```ts
	getTranscriptCacheDir: () => string;
	getCaptionDraftsDir: () => string;
```

5d. Instantiate the service inside `registerNativeBridgeHandlers`, after `cursorService`:

```ts
	const transcriptService = new TranscriptService({
		cacheDir: context.getTranscriptCacheDir(),
		draftsDir: context.getCaptionDraftsDir(),
		resolveSourcePath: (sourcePath: string) => context.resolveVideoPath(sourcePath),
	});
```

5e. Add the `transcript` domain case inside the `switch (request.domain)` block (after the `cursor` case, before `default`):

```ts
				case "transcript": {
					const action = request.action as string;
					switch (request.action) {
						case "getTranscript":
							return createSuccessResponse(
								requestId,
								await transcriptService.getTranscript(request.payload.sourcePath),
							);
						case "putTranscript":
							return createSuccessResponse(
								requestId,
								await transcriptService.putTranscript(
									request.payload.sourcePath,
									request.payload.transcript,
								),
							);
						case "getCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.getCaptionDraft(request.payload.sourcePath),
							);
						case "putCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.putCaptionDraft(
									request.payload.sourcePath,
									request.payload.regions,
								),
							);
						case "clearCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.clearCaptionDraft(request.payload.sourcePath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported transcript action: ${action}`,
							);
					}
				}
```

- [ ] **Step 6: Supply the dirs from `electron/ipc/handlers.ts`**

Add these two fields to the object passed to `registerNativeBridgeHandlers({ ... })` (near `resolveAssetBasePath`). `app` and `path` are already imported in this file.

```ts
		getTranscriptCacheDir: () => path.join(app.getPath("userData"), "transcripts"),
		getCaptionDraftsDir: () => path.join(app.getPath("userData"), "caption-drafts"),
```

- [ ] **Step 7: Typecheck + run the service test again**

Run: `npx tsc --noEmit && npx vitest run electron/native-bridge/services/transcriptService.test.ts`
Expected: tsc exit 0; tests PASS.

- [ ] **Step 8: Commit**

```bash
git add electron/native-bridge/services/transcriptService.ts electron/native-bridge/services/transcriptService.test.ts electron/ipc/nativeBridge.ts electron/ipc/handlers.ts
git commit -m "feat(native-bridge): add transcript cache + caption draft service"
```

---

## Task 5: `useTranscript` orchestration hook

**Files:**
- Create: `src/hooks/useTranscript.ts`

**Interfaces:**
- Consumes: `getActiveProvider`, `Transcript`, `TranscriptStatus`, `TranscribeVideoResult`, `TranscriptionNoAudioError`, `TRANSCRIPT_SCHEMA_VERSION` from `@/lib/transcription`; `nativeBridgeClient` from `@/native`; `TrimRegion` from `@/components/video-editor/types`.
- Produces:
  - `interface UseTranscriptResult { status: TranscriptStatus; transcript: Transcript | null; ensureTranscript: () => Promise<Transcript | null>; regenerate: () => Promise<Transcript | null> }`
  - `useTranscript(params: { videoUrl: string | null; sourcePath: string | null; trimRegions: TrimRegion[] }): UseTranscriptResult`

Notes:
- `videoUrl` is the `file://` URL passed to the provider (audio extraction); `sourcePath` is the raw path used as the cache key.
- `nativeBridgeClient` is exported from `src/native/index.ts` — verify it re-exports `client.ts`; if not, import from `@/native/client`.

- [ ] **Step 1: Write `src/hooks/useTranscript.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { TrimRegion } from "@/components/video-editor/types";
import {
	getActiveProvider,
	type Transcript,
	TRANSCRIPT_SCHEMA_VERSION,
	TranscriptionNoAudioError,
	type TranscriptStatus,
} from "@/lib/transcription";
import { nativeBridgeClient } from "@/native/client";

export interface UseTranscriptResult {
	status: TranscriptStatus;
	transcript: Transcript | null;
	/** Returns the ready transcript, using cache/in-flight work; generates on a miss. */
	ensureTranscript: () => Promise<Transcript | null>;
	/** Forces a fresh transcription, ignoring the cache, and rewrites it. */
	regenerate: () => Promise<Transcript | null>;
}

function isTranscript(value: unknown): value is Transcript {
	return (
		!!value &&
		typeof value === "object" &&
		Array.isArray((value as Transcript).segments) &&
		(value as Transcript).schemaVersion === TRANSCRIPT_SCHEMA_VERSION
	);
}

/**
 * Ensures a transcript exists for the loaded video: checks the sidecar cache, otherwise transcribes
 * silently in the background and writes the cache. Runs automatically when the video changes; also
 * exposes `ensureTranscript`/`regenerate` for the Auto-captions flow to reuse the same work.
 */
export function useTranscript(params: {
	videoUrl: string | null;
	sourcePath: string | null;
	trimRegions: TrimRegion[];
}): UseTranscriptResult {
	const { videoUrl, sourcePath, trimRegions } = params;

	const [status, setStatus] = useState<TranscriptStatus>({ state: "idle" });
	const [transcript, setTranscript] = useState<Transcript | null>(null);

	// One in-flight run per source path; abort on video change/unmount.
	const inFlightRef = useRef<{ key: string; promise: Promise<Transcript | null> } | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	// Latest trimRegions without making callbacks depend on their identity.
	const trimRegionsRef = useRef<TrimRegion[]>(trimRegions);
	trimRegionsRef.current = trimRegions;

	const run = useCallback(
		async (url: string, source: string, opts: { ignoreCache: boolean }): Promise<Transcript | null> => {
			if (!opts.ignoreCache) {
				const cached = await nativeBridgeClient.transcript.getTranscript(source);
				if (cached.success && isTranscript(cached.transcript)) {
					const t = cached.transcript;
					setTranscript(t.segments.length > 0 ? t : null);
					setStatus(t.segments.length > 0 ? { state: "ready", transcript: t } : { state: "no-speech" });
					return t;
				}
			}

			const controller = new AbortController();
			abortRef.current?.abort();
			abortRef.current = controller;

			setStatus({ state: "transcribing" });
			const provider = getActiveProvider();
			try {
				const result = await provider.transcribe(url, {
					trimRegions: trimRegionsRef.current,
					signal: controller.signal,
					onStatus: (phase) =>
						setStatus(phase === "model" ? { state: "preparing-model" } : { state: "transcribing" }),
				});
				const built: Transcript = {
					segments: result.segments,
					granularity: result.granularity,
					provider: provider.id,
					model: provider.model,
					audioDurationSec: result.audioDurationSec,
					truncated: result.truncated,
					createdAt: Date.now(),
					schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
				};
				// Cache even an empty (no-speech) result so we don't re-run every load.
				await nativeBridgeClient.transcript.putTranscript(source, built);
				if (built.segments.length === 0) {
					setTranscript(null);
					setStatus({ state: "no-speech" });
				} else {
					setTranscript(built);
					setStatus({ state: "ready", transcript: built });
				}
				return built;
			} catch (error) {
				if (controller.signal.aborted) return null;
				if (error instanceof TranscriptionNoAudioError) {
					setStatus({ state: "no-audio" });
					return null;
				}
				const message = error instanceof Error ? error.message : String(error);
				console.warn("[useTranscript] transcription failed:", message);
				setStatus({ state: "error", message });
				return null;
			}
		},
		[],
	);

	const ensureTranscript = useCallback(async (): Promise<Transcript | null> => {
		if (!videoUrl || !sourcePath) return null;
		const key = sourcePath;
		if (inFlightRef.current?.key === key) return inFlightRef.current.promise;
		const promise = run(videoUrl, sourcePath, { ignoreCache: false }).finally(() => {
			if (inFlightRef.current?.key === key) inFlightRef.current = null;
		});
		inFlightRef.current = { key, promise };
		return promise;
	}, [videoUrl, sourcePath, run]);

	const regenerate = useCallback(async (): Promise<Transcript | null> => {
		if (!videoUrl || !sourcePath) return null;
		return run(videoUrl, sourcePath, { ignoreCache: true });
	}, [videoUrl, sourcePath, run]);

	// Auto-run silently when the video changes.
	useEffect(() => {
		if (!videoUrl || !sourcePath) {
			setStatus({ state: "idle" });
			setTranscript(null);
			return;
		}
		setTranscript(null);
		void ensureTranscript();
		return () => {
			abortRef.current?.abort();
		};
	}, [videoUrl, sourcePath, ensureTranscript]);

	return { status, transcript, ensureTranscript, regenerate };
}
```

- [ ] **Step 2: Verify `@/native/client` import resolves**

Run: `npx tsc --noEmit`
Expected: exit 0. If `@/native/client` fails to resolve, confirm the path alias and that `src/native/client.ts` exists (it does).

- [ ] **Step 3: Lint**

Run: `npx biome check src/hooks/useTranscript.ts src/lib/transcription`
Expected: no errors (fix formatting if Biome rewrites).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTranscript.ts
git commit -m "feat(transcription): add useTranscript orchestration hook"
```

---

## Task 6: Wire into VideoEditor — auto-transcribe, reuse in Auto captions, autosave drafts

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx`

**Interfaces:**
- Consumes: `useTranscript` (Task 5), `captionSegmentsToAnnotationRegions` (already imported), `nativeBridgeClient.transcript` (Task 3), `MAX_CAPTION_AUDIO_SEC` (already imported).
- Produces: no new exports (integration only).

This task touches the large `VideoEditor.tsx`. Anchor each edit on the quoted existing code.

- [ ] **Step 1: Import the hook.** Near the other hook imports (e.g. after the `useEditorHistory` import), add:

```ts
import { useTranscript } from "@/hooks/useTranscript";
```

- [ ] **Step 2: Instantiate the hook.** After the annotation id refs (anchor on `const nextAnnotationZIndexRef = useRef(1);`), add:

```ts
	const {
		transcript,
		status: transcriptStatus,
		ensureTranscript,
	} = useTranscript({
		videoUrl: videoPath,
		sourcePath: videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null),
		trimRegions,
	});
	// Referenced by the caption flow; keeps lints quiet until a transcript UI lands.
	void transcript;
	void transcriptStatus;
```

- [ ] **Step 3: Write the failing behaviour into `generateAutoCaptions` — reuse the stored transcript.**

Replace the body from the `try {` through the assignment of `segments` (anchor start `const { samples, truncated, durationSec } = await extractMono16kFromVideoUrl(videoPath);` … anchor end the block that produces `const segments = ...`) with a call to `ensureTranscript()`. The new `try` block opening becomes:

```ts
			try {
				const ready = await ensureTranscript();
				if (!ready) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					// Distinguish no-audio from no-speech using the hook's status set by ensureTranscript.
					toast[transcriptStatusRef.current.state === "no-audio" ? "error" : "info"](
						transcriptStatusRef.current.state === "no-audio"
							? t("autoCaptions.noAudio")
							: t("autoCaptions.noneHeard"),
					);
					return;
				}
				const segments = ready.segments;
				const granularity = ready.granularity;
				const truncated = ready.truncated;
```

Then keep the EXISTING code from `let { regions, nextNumericId, nextZIndex } = captionSegmentsToAnnotationRegions(` onward unchanged (region conversion, empty-region retry, `pushState`, success/truncated toasts, `catch`, `finally`).

Delete the now-unused inline transcription code (the `extractMono16kFromVideoUrl` call, `trimLeadingSilenceMono16k`, both `transcribeMono16kToSegments` calls, and the `segments` remap) — it now lives in the provider.

- [ ] **Step 4: Add a ref mirroring transcript status** (so the callback reads the latest without a dep). After the hook instantiation in Step 2, add:

```ts
	const transcriptStatusRef = useRef(transcriptStatus);
	transcriptStatusRef.current = transcriptStatus;
```

- [ ] **Step 5: Prune now-unused imports.** If `extractMono16kFromVideoUrl`, `trimLeadingSilenceMono16k`, `shiftTrimRegionsMsForCaptionBuffer`, or `transcribeMono16kToSegments` are no longer referenced elsewhere in the file, remove them from the `@/lib/captioning` import. Keep `captionSegmentsToAnnotationRegions`, `reconcileAutoCaptionTimelineGaps`, and `MAX_CAPTION_AUDIO_SEC` (still used).

Run: `npx tsc --noEmit` and let unused-import errors tell you exactly what to drop. Expected after pruning: exit 0.

- [ ] **Step 6: Autosave caption drafts (debounced).** After the existing preferences autosave effect (anchor on `saveUserPreferences({ padding, aspectRatio, exportQuality, exportFormat });`), add a new effect:

```ts
	// Autosave auto-caption regions to a userData draft so caption work isn't lost before an
	// explicit project save. Keyed to the video; superseded/cleared after a successful save.
	useEffect(() => {
		const source = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
		if (!source) return;
		const captionRegions = annotationRegions.filter((r) => r.annotationSource === "auto-caption");
		if (captionRegions.length === 0) return;
		const handle = setTimeout(() => {
			void nativeBridgeClient.transcript
				.putCaptionDraft(source, captionRegions)
				.catch((err) => console.warn("[VideoEditor] caption draft autosave failed:", err));
		}, 800);
		return () => clearTimeout(handle);
	}, [annotationRegions, videoSourcePath, videoPath]);
```

Ensure `nativeBridgeClient` is imported (it already is for project ops). If only a subset is imported, confirm `nativeBridgeClient` is the imported symbol.

- [ ] **Step 7: Clear the draft after a successful save.** In `saveProject`, after the save is confirmed successful (anchor on the block following `const result = await nativeBridgeClient.project.saveProjectFile(` where `result.success` is handled), add:

```ts
			const savedSource = currentProjectMedia.screenVideoPath;
			if (savedSource) {
				void nativeBridgeClient.transcript
					.clearCaptionDraft(savedSource)
					.catch((err) => console.warn("[VideoEditor] clear caption draft failed:", err));
			}
```

- [ ] **Step 8: Restore a caption draft on load (only when no project captions).** In the `loadInitialData` effect, in the branch that handles a recording session / `getCurrentVideoPath` (i.e. NOT a loaded project — anchor on `setLastSavedSnapshot(` inside the `getCurrentVideoPath` success branch), after `setVideoPath(...)`, add:

```ts
					void nativeBridgeClient.transcript
						.getCaptionDraft(result.path)
						.then((draft) => {
							if (
								draft.success &&
								Array.isArray(draft.regions) &&
								draft.regions.length > 0
							) {
								updateState({ annotationRegions: draft.regions as AnnotationRegion[] });
								nextAnnotationIdRef.current = deriveNextId(draft.regions as AnnotationRegion[]);
							}
						})
						.catch((err) => console.warn("[VideoEditor] caption draft restore failed:", err));
```

Confirm `deriveNextId` (used already at ~line 449) and `AnnotationRegion` are in scope/imported. If `deriveNextId` takes different args, match its existing call site.

- [ ] **Step 9: Manual verification against the running app.**

Run the app (`npm run dev` is already running with the action logger). Then:
1. Import a video with speech. In the dev terminal / action-logger JSONL, confirm background transcription runs (no toast) and a file appears under `userData/transcripts/`.
2. Click **Auto captions** → captions appear quickly (reusing the cache; no second ~45s wait). Confirm via the action-logger log (`toast success "Added N captions."`).
3. Edit a caption, wait ~1s, confirm a file appears under `userData/caption-drafts/`.
4. Reload the same video (new session) → captions/draft restore; transcript is not regenerated (no `transcribing` status; instant).
5. Import a silent video → clicking Auto captions shows "No speech was detected." instantly.

Paths: `~/Library/Application Support/openscreen/transcripts/` and `.../caption-drafts/`.

- [ ] **Step 10: Full gate.**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: all pass. (Add `npm run test:browser` only if the captioning/export path was touched — it was not, beyond moving logic into the provider; run it if unsure.)

- [ ] **Step 11: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(transcription): auto-transcribe on load, reuse in auto-captions, autosave caption drafts"
```

---

## Task 7: Update project docs (CLAUDE.md files)

Per the repo's maintenance convention (root `CLAUDE.md`): when a folder's structure/conventions/architecture change, update that folder's `CLAUDE.md` in the same change. This feature adds a new `src/lib/transcription/` module, a `useTranscript` hook, a native-bridge `transcript` domain, and two `userData` dirs — so the folder docs must reflect that.

**Files:**
- Modify: `src/CLAUDE.md`
- Modify: `electron/CLAUDE.md`

**Interfaces:** Docs only — no code.

- [ ] **Step 1: Update `src/CLAUDE.md`.**
  - In the `lib/` bullet, add `transcription/` alongside `exporter/`, `captioning/`, `cursor/` — one clause: "`transcription/` (provider-abstracted transcript generation wrapping `captioning/`; Whisper default, cached per-video via the native bridge)".
  - In the `hooks/` mention, note `useTranscript` (auto-generates + caches the transcript on video load).
  - In the `native/` bullet, note the new `nativeBridgeClient.transcript.*` facade (transcript cache + caption drafts).

- [ ] **Step 2: Update `electron/CLAUDE.md`.**
  - In the native-bridge section, add the `transcript` domain/service to the list of services (`services/transcriptService.ts` — fs-backed sidecar transcript cache + caption autosave drafts under `userData/transcripts/` and `userData/caption-drafts/`, keyed by a video stat signature).

- [ ] **Step 3: Verify no stale references** — reread both edits; confirm they match the code shipped in Tasks 1–6 (module path, hook name, client method names, service filename, dir names).

- [ ] **Step 4: Commit**

```bash
git add src/CLAUDE.md electron/CLAUDE.md
git commit -m "docs: document transcription module + native-bridge transcript domain"
```

Note: these `CLAUDE.md` files are currently untracked; committing here brings them under version control on this branch. Confirm with the human if they should stay untracked instead.

---

## Self-Review

**Spec coverage:**
- Auto-generate on load → Task 5 (`useTranscript` auto-run effect) + Task 6 (wiring). ✅
- Silent, not shown in UI → Task 5 sets status only; no toast on background run; `transcript`/`status` are `void`-referenced in Task 6 (no UI). ✅
- Transcript vs captions separation → transcript in sidecar (Task 4), captions in project + draft (Task 4/6). ✅
- Never re-transcribe same video → cache + stat-signature key (Task 4), cache check (Task 5). ✅
- Persistence option C + load priority → `resolveTranscriptLoadPlan` (Task 2), draft restore/save/clear (Task 6). ✅ (Note: Task 6 implements the priority directly in the load effect; `resolveTranscriptLoadPlan` is available as the tested pure encoding — Step 8 restores draft only when no project captions, matching it.)
- Cache never overwrites edited captions → transcript cache and caption stores are disjoint; regeneration writes only the transcript cache. ✅
- Auto captions reuses transcript → Task 6 Step 3. ✅
- Modular/configurable provider → Tasks 1 (interface + config). ✅
- Model bundled, `preparing-model` from existing `onStatus("model")` → Task 5. ✅
- No new i18n strings → Task 6 reuses `autoCaptions.noAudio`/`noneHeard`. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code. Anchored edits in Task 6 quote exact existing strings.

**Type consistency:** `Transcript`, `TranscribeVideoResult`, `TranscriptStatus`, `TranscriptCacheResult`, `CaptionDraftResult`, provider `{id,model,transcribe}`, and client method names are identical across Tasks 1/3/4/5/6. Cache key computed only in the main service (Task 4); renderer passes `sourcePath`.

**Known integration risk (flagged for the executor):** Task 6 Steps 7–8 anchor inside large existing functions (`saveProject`, `loadInitialData`); if the surrounding code differs, place the calls at the semantically equivalent point (after successful save; in the non-project video-load branch) rather than matching lines verbatim.
