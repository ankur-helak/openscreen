# AI Doc Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click turns a narrated recording into a Trupeer-style visual product walkthrough saved as a self-contained HTML file (+ PDF), with interaction-anchored steps, composited screenshots, and multimodal (vision + transcript) AI generation.

**Architecture:** Reuse the `scriptPolish` native-bridge seam for BYO-key plumbing. Screenshots are captured in the renderer by reusing the exporter's `StreamingVideoDecoder` + `FrameRenderer`; the multimodal OpenAI call and the HTML/PDF file writes run in the main process behind a new `docExport` native-bridge domain. Steps derive deterministically from clicks + zoom/annotation moments; the AI writes prose per pre-defined step id (1:1, id-set-exact validated, atomic). The OpenAI key is shared with Script Polish via a new `OpenAiKeyStore`.

**Tech Stack:** Electron (main), React + TypeScript (renderer), Vitest (jsdom + browser tiers), WebCodecs / pixi.js (`FrameRenderer`), Electron `safeStorage` + `dialog.showSaveDialog` + `webContents.printToPDF`, OpenAI Chat Completions.

## Global Constraints

- Node **22.x**, npm **10.x**.
- Renderer (`src/`) imports via the **`@/*`** alias only; main (`electron/`) uses **relative imports** and may import **types** from `src/` (e.g. `../../../src/native/contracts`).
- OpenAI: model **`gpt-4o-mini`** (multimodal); endpoint `https://api.openai.com/v1/chat/completions`; `response_format: { type: "json_object" }`; timeout via `AbortSignal.timeout(...)`.
- BYO key stored via Electron **`safeStorage`** in the **main process**; the renderer only ever learns `hasKey`; the raw key never enters the renderer bundle.
- Screenshots (base64) are the **only non-text data** leaving the device — the Doc Export UI must show a disclosure.
- Production build **drops `console.log`/`console.debug`** — logging that must survive uses `console.warn`/`console.error`/`console.info`, tagged `[Component]`.
- TS: `interface` for object shapes, `type` for unions; **no `enum`**; avoid `any`.
- React: `function` declarations + an `XxxProps` interface; Tailwind via `cn()`/`cva`.
- i18n: any user-facing string added to **all 13 locales** — `ar, en, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW`; verify `npm run i18n:check`. (The exported *document's* body text is in the recording's language and is not localized — only app-chrome strings are.)
- Tests co-located (`foo.ts` → `foo.test.ts`); real-Web-API code uses `*.browser.test.ts`.
- Pre-PR green: `npm run lint && npx tsc --noEmit && npm run test` (+ `npm run test:browser` since this touches render code; + `npm run i18n:check`). Husky runs lint-staged on commit; never `--no-verify`.

---

## File Structure

**New — renderer pure libs (`src/lib/docExport/`):**
- `types.ts` — shared types (`DocStep`, `DocStepInput`, `DeriveStepsInput`, re-exported `GeneratedDoc`).
- `steps.ts` — `deriveSteps()` (interaction coalescing + narration fallback).
- `validateDoc.ts` — `validateGeneratedDoc()` (id-set-exact + field guard).
- `renderHtml.ts` — `renderDocHtml()` (self-contained HTML, inline base64 images).
- `index.ts` — barrel.

**New — renderer impure:**
- `src/lib/docExport/screenshots.ts` — `captureStepScreenshots()` (decoder + `FrameRenderer` reuse).
- `src/hooks/useDocExport.ts` — orchestration hook.

**New — main process:**
- `electron/native-bridge/services/openAiKeyStore.ts` — shared key store + legacy migration.
- `electron/native-bridge/services/docExportService.ts` — multimodal `generate()` + `save()`.

**New — i18n:**
- `src/i18n/locales/<locale>/docExport.json` × 13.

**Modified:**
- `src/native/contracts.ts` — `docExport` domain + result types.
- `src/native/client.ts` — `docExport` client block.
- `electron/ipc/nativeBridge.ts` — shared key store, `docExport` dispatch, context dir.
- `electron/ipc/handlers.ts` — `getOpenAiConfigDir` in the bridge context.
- `electron/native-bridge/services/scriptPolishService.ts` — use the shared `OpenAiKeyStore`.
- `electron/native-bridge/services/scriptPolishService.test.ts` — construct via the store.
- `src/components/video-editor/SettingsPanel.tsx` — "Export doc" button + disclosure.
- `src/components/video-editor/VideoEditor.tsx` — wire `useDocExport`, gating, key affordance.
- `src/i18n/config.ts` — register the `docExport` namespace.

---

## Task 1: Shared `OpenAiKeyStore` (+ migration) and refactor Script Polish onto it

**Files:**
- Create: `electron/native-bridge/services/openAiKeyStore.ts`
- Test: `electron/native-bridge/services/openAiKeyStore.test.ts`
- Modify: `electron/native-bridge/services/scriptPolishService.ts`
- Modify: `electron/native-bridge/services/scriptPolishService.test.ts`

**Interfaces:**
- Produces: `class OpenAiKeyStore` with `readKey(): Promise<string|null>`, `getKeyStatus(): Promise<{hasKey:boolean}>`, `setKey(key:string): Promise<{success:boolean;message?:string}>`, `clearKey(): Promise<{success:boolean;message?:string}>`. Constructor: `new OpenAiKeyStore({ configDir: string; legacyDir?: string; safeStorageImpl?: SafeStorageLike })`.
- Consumes (later): `ScriptPolishService` and `DocExportService` both take `{ keyStore: OpenAiKeyStore }`.

- [ ] **Step 1: Write the failing test**

Create `electron/native-bridge/services/openAiKeyStore.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OpenAiKeyStore } from "./openAiKeyStore";

// Fake safeStorage: base64 "encryption" so tests need no OS keychain.
const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
	decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
};

async function tmp(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "openai-key-"));
}

describe("OpenAiKeyStore", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await tmp();
	});

	it("round-trips set/status/clear", async () => {
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		expect((await store.getKeyStatus()).hasKey).toBe(false);
		expect((await store.setKey("sk-test")).success).toBe(true);
		expect((await store.getKeyStatus()).hasKey).toBe(true);
		expect(await store.readKey()).toBe("sk-test");
		expect((await store.clearKey()).success).toBe(true);
		expect((await store.getKeyStatus()).hasKey).toBe(false);
	});

	it("rejects an empty key", async () => {
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		expect((await store.setKey("   ")).success).toBe(false);
	});

	it("migrates a key from the legacy dir on first read", async () => {
		const legacyDir = await tmp();
		await writeFile(
			path.join(legacyDir, "openai-key.enc"),
			fakeSafeStorage.encryptString("sk-legacy") as unknown as Buffer,
		);
		const store = new OpenAiKeyStore({
			configDir: dir,
			legacyDir,
			safeStorageImpl: fakeSafeStorage,
		});
		expect(await store.readKey()).toBe("sk-legacy");
		// Migrated into the new location.
		const migrated = await readFile(path.join(dir, "openai-key.enc"));
		expect(fakeSafeStorage.decryptString(migrated)).toBe("sk-legacy");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/native-bridge/services/openAiKeyStore.test.ts`
Expected: FAIL — `Cannot find module './openAiKeyStore'`.

- [ ] **Step 3: Write the implementation**

Create `electron/native-bridge/services/openAiKeyStore.ts`:

```ts
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

const KEY_FILE = "openai-key.enc";

export type SafeStorageLike = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
};

export interface OpenAiKeyStoreOptions {
	/** Directory for the encrypted key (e.g. userData/openai). */
	configDir: string;
	/** Legacy directory to migrate a key from once (e.g. userData/script-polish). */
	legacyDir?: string;
	/** Injectable for tests; defaults to Electron safeStorage. */
	safeStorageImpl?: SafeStorageLike;
}

/**
 * Shared BYO OpenAI key, stored encrypted via Electron safeStorage in the main process.
 * Used by ScriptPolishService and DocExportService so both features share one key.
 */
export class OpenAiKeyStore {
	private readonly configDir: string;
	private readonly legacyDir?: string;
	private safeStorageImpl?: SafeStorageLike;
	private migrated = false;

	constructor(options: OpenAiKeyStoreOptions) {
		this.configDir = options.configDir;
		this.legacyDir = options.legacyDir;
		this.safeStorageImpl = options.safeStorageImpl;
	}

	private ss(): SafeStorageLike {
		this.safeStorageImpl ??= safeStorage;
		return this.safeStorageImpl;
	}

	private keyFile(): string {
		return path.join(this.configDir, KEY_FILE);
	}

	private async migrateIfNeeded(): Promise<void> {
		if (this.migrated || !this.legacyDir) return;
		this.migrated = true;
		const legacy = path.join(this.legacyDir, KEY_FILE);
		try {
			await access(this.keyFile());
			return; // new key already exists — nothing to migrate.
		} catch {
			// fall through
		}
		try {
			await access(legacy);
			await mkdir(this.configDir, { recursive: true });
			await copyFile(legacy, this.keyFile());
		} catch {
			// no legacy key — nothing to do.
		}
	}

	async readKey(): Promise<string | null> {
		await this.migrateIfNeeded();
		try {
			const buf = await readFile(this.keyFile());
			return this.ss().decryptString(buf);
		} catch {
			return null;
		}
	}

	async getKeyStatus(): Promise<{ hasKey: boolean }> {
		return { hasKey: (await this.readKey()) !== null };
	}

	async setKey(key: string): Promise<{ success: boolean; message?: string }> {
		try {
			const trimmed = key.trim();
			if (!trimmed) return { success: false, message: "Empty key." };
			if (!this.ss().isEncryptionAvailable()) {
				return { success: false, message: "Secure storage unavailable on this system." };
			}
			await mkdir(this.configDir, { recursive: true });
			await writeFile(this.keyFile(), this.ss().encryptString(trimmed));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearKey(): Promise<{ success: boolean; message?: string }> {
		try {
			await rm(this.keyFile(), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/native-bridge/services/openAiKeyStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor `ScriptPolishService` onto the store**

Replace the top of `electron/native-bridge/services/scriptPolishService.ts` (imports through the constructor + the key methods, lines 1–91) with:

```ts
import type {
	ScriptPolishKeyResult,
	ScriptPolishKeyStatus,
	ScriptPolishResult,
} from "../../../src/native/contracts";
import type { OpenAiKeyStore } from "./openAiKeyStore";

/** Hard-coded v1 model (see plan Global Constraints). */
const SCRIPT_POLISH_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface ScriptPolishServiceOptions {
	/** Shared OpenAI key store. */
	keyStore: OpenAiKeyStore;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Runs the OpenAI script-polish call in the main process. The BYO key is owned by the
 * shared OpenAiKeyStore; the renderer never receives it — only `hasKey`. v1 sends text only.
 */
export class ScriptPolishService {
	private readonly keyStore: OpenAiKeyStore;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ScriptPolishServiceOptions) {
		this.keyStore = options.keyStore;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async getKeyStatus(): Promise<ScriptPolishKeyStatus> {
		return this.keyStore.getKeyStatus();
	}

	async setKey(key: string): Promise<ScriptPolishKeyResult> {
		return this.keyStore.setKey(key);
	}

	async clearKey(): Promise<ScriptPolishKeyResult> {
		return this.keyStore.clearKey();
	}
```

Then in `polish()` (was line 97) change `const key = await this.readKey();` to `const key = await this.keyStore.readKey();`. Leave the rest of `polish()` unchanged. Delete the now-unused `node:fs/promises`, `node:path`, `safeStorage`, `SafeStorageLike`, `KEY_FILE`, `safeStorage()`, `keyFile()`, `readKey()` members.

- [ ] **Step 6: Update `scriptPolishService.test.ts` to construct via the store**

At the top of `electron/native-bridge/services/scriptPolishService.test.ts`, import the store and build the service from it. Replace each `new ScriptPolishService({ configDir, safeStorageImpl: fakeSafeStorage, fetchImpl })` construction with:

```ts
import { OpenAiKeyStore } from "./openAiKeyStore";
// …
const keyStore = new OpenAiKeyStore({ configDir, safeStorageImpl: fakeSafeStorage });
const service = new ScriptPolishService({ keyStore, fetchImpl });
```

Keep every existing assertion (key round-trip, `no-key`, success header/body shape, `api-error`, `invalid-response`) — they should all still pass because behavior is unchanged.

- [ ] **Step 7: Run the full main-process service tests**

Run: `npx vitest run electron/native-bridge/services/`
Expected: PASS (openAiKeyStore + scriptPolishService green).

- [ ] **Step 8: Commit**

```bash
git add electron/native-bridge/services/openAiKeyStore.ts electron/native-bridge/services/openAiKeyStore.test.ts electron/native-bridge/services/scriptPolishService.ts electron/native-bridge/services/scriptPolishService.test.ts
git commit -m "$(cat <<'EOF'
refactor(doc-export): extract shared OpenAiKeyStore from scriptPolish

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Screenshot capture (browser-tier spike) — `captureStepScreenshots`

> **This is the plan's riskiest reuse. Do it early.** If the decoder + `FrameRenderer` reuse proves awkward, this is where the design flexes.

**Files:**
- Create: `src/lib/docExport/screenshots.ts`
- Test: `src/lib/docExport/screenshots.browser.test.ts`

**Interfaces:**
- Produces: `type DocScreenshotConfig = Omit<FrameRenderConfig, "videoWidth" | "videoHeight"> & { videoUrl: string; frameRate: number }` and `captureStepScreenshots(config: DocScreenshotConfig, timesMs: number[]): Promise<string[]>` — returns PNG **data URLs** aligned to `timesMs`.
- Consumes: `FrameRenderer` + `FrameRenderConfig` from `@/lib/exporter/frameRenderer`; `StreamingVideoDecoder` from `@/lib/exporter/streamingDecoder` (`loadMetadata(url) → { width, height, ... }`, `decodeAll(frameRate, trimRegions, speedRegions, cb(frame, exportTsUs, sourceMs), onWarning?)`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/docExport/screenshots.browser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
import { captureStepScreenshots } from "./screenshots";

describe("captureStepScreenshots (real browser)", () => {
	it("returns one PNG data URL per requested timestamp", async () => {
		const shots = await captureStepScreenshots(
			{
				videoUrl: sampleVideoUrl,
				frameRate: 15,
				width: 320,
				height: 180,
				wallpaper: "#1a1a2e",
				zoomRegions: [],
				showShadow: false,
				shadowIntensity: 0,
				showBlur: false,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			},
			[0, 300],
		);

		expect(shots).toHaveLength(2);
		for (const url of shots) {
			expect(url.startsWith("data:image/png;base64,")).toBe(true);
			expect(url.length).toBeGreaterThan(1024); // non-trivial image
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --config vitest.browser.config.ts run src/lib/docExport/screenshots.browser.test.ts`
Expected: FAIL — `Cannot find module './screenshots'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/docExport/screenshots.ts`:

```ts
import { type FrameRenderConfig, FrameRenderer } from "@/lib/exporter/frameRenderer";
import { StreamingVideoDecoder } from "@/lib/exporter/streamingDecoder";

const SCREENSHOT_MAX_W = 1440;

export type DocScreenshotConfig = Omit<FrameRenderConfig, "videoWidth" | "videoHeight"> & {
	videoUrl: string;
	frameRate: number;
};

function canvasToDataUrl(canvas: HTMLCanvasElement, maxW: number): string {
	const scale = canvas.width > maxW ? maxW / canvas.width : 1;
	if (scale === 1) return canvas.toDataURL("image/png");
	const out = document.createElement("canvas");
	out.width = Math.round(canvas.width * scale);
	out.height = Math.round(canvas.height * scale);
	const ctx = out.getContext("2d");
	if (!ctx) return canvas.toDataURL("image/png");
	ctx.drawImage(canvas, 0, 0, out.width, out.height);
	return out.toDataURL("image/png");
}

/**
 * Capture a composited screenshot (cursor/zoom/annotations baked in) at each timestamp,
 * by a single linear decode pass over the video — no random-access seeking. Results are
 * returned as PNG data URLs aligned to `timesMs` order.
 */
export async function captureStepScreenshots(
	config: DocScreenshotConfig,
	timesMs: number[],
): Promise<string[]> {
	if (timesMs.length === 0) return [];
	const targets = [...timesMs].sort((a, b) => a - b);
	const results: string[] = new Array(targets.length).fill("");

	const decoder = new StreamingVideoDecoder();
	const info = await decoder.loadMetadata(config.videoUrl);
	const renderer = new FrameRenderer({
		...config,
		videoWidth: info.width,
		videoHeight: info.height,
	} as FrameRenderConfig);
	await renderer.initialize();

	let idx = 0;
	let last = "";
	await decoder.decodeAll(config.frameRate, [], [], async (frame, _exportTsUs, sourceMs) => {
		try {
			if (idx < targets.length && sourceMs >= targets[idx]) {
				await renderer.renderFrame(frame, sourceMs * 1000, null);
				last = canvasToDataUrl(renderer.getCanvas(), SCREENSHOT_MAX_W);
				while (idx < targets.length && sourceMs >= targets[idx]) {
					results[idx] = last;
					idx++;
				}
			}
		} finally {
			frame.close();
		}
	});

	// Targets past the final frame → fall back to the last rendered frame.
	for (let i = 0; i < results.length; i++) {
		if (!results[i]) results[i] = last;
	}
	return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --config vitest.browser.config.ts run src/lib/docExport/screenshots.browser.test.ts`
Expected: PASS.

> If `decodeAll`'s third positional arg (speedRegions) or the metadata field names differ, align with the live usage in `src/lib/exporter/videoExporter.ts:352` and `:229`. If capture is blank, force a CPU readback like `videoExporter.ts:384` (Linux path).

- [ ] **Step 5: Commit**

```bash
git add src/lib/docExport/screenshots.ts src/lib/docExport/screenshots.browser.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): composited screenshot capture via decoder+FrameRenderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Types + `deriveSteps`

**Files:**
- Create: `src/lib/docExport/types.ts`
- Create: `src/lib/docExport/steps.ts`
- Test: `src/lib/docExport/steps.test.ts`

**Interfaces:**
- Produces: the types below, and `deriveSteps(input: DeriveStepsInput): DocStep[]`.
- Consumes: `DocExportGeneratedDoc` from `@/native/contracts` (added in Task 5; this task compiles against the local types and only needs `@/native/contracts` for the `GeneratedDoc` re-export — if Task 5 hasn't run yet, temporarily inline the `GeneratedDoc` shape and swap to the import when Task 5 lands).

- [ ] **Step 1: Create the types file**

Create `src/lib/docExport/types.ts`:

```ts
import type { DocExportGeneratedDoc } from "@/native/contracts";

/** The AI-generated document shape (single source of truth is the wire contract). */
export type GeneratedDoc = DocExportGeneratedDoc;
export type GeneratedDocStep = DocExportGeneratedDoc["steps"][number];

/** A narration span from the transcript (or voiceover script when present). */
export interface NarrationSegment {
	sourceStartMs: number;
	sourceEndMs: number;
	text: string;
}

/** A derived step: an interaction anchor + the narration overlapping its span. */
export interface DocStep {
	id: string; // "step-1", "step-2", …
	screenshotMs: number; // instant to capture the composited frame
	spanStartMs: number;
	spanEndMs: number;
	transcriptText: string;
}

/** Per-step payload sent to the model (text + image). */
export interface DocStepInput {
	id: string;
	transcriptText: string;
	imageDataUrl: string;
}

export interface DeriveStepsInput {
	/** Click sample times (ms), from cursor samples with interactionType === "click". */
	clicks: number[];
	/** Zoom region start times (ms). */
	zoomStarts: number[];
	/** Annotation region start times (ms), excluding auto-captions. */
	annotationStarts: number[];
	/** Narration segments (voiceover.segments if present, else segmented transcript). */
	narration: NarrationSegment[];
	/** Output end time (ms) — bounds the last step's span. */
	endMs: number;
	coalesceMs?: number;
	maxSteps?: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/docExport/steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSteps } from "./steps";
import type { NarrationSegment } from "./types";

const narration: NarrationSegment[] = [
	{ sourceStartMs: 0, sourceEndMs: 900, text: "Open the homepage." },
	{ sourceStartMs: 1000, sourceEndMs: 1900, text: "Click create." },
	{ sourceStartMs: 5000, sourceEndMs: 5900, text: "Fill in the details." },
];

describe("deriveSteps", () => {
	it("coalesces nearby interactions and attaches the overlapping narration", () => {
		const steps = deriveSteps({
			clicks: [100, 200, 5100], // 100 & 200 coalesce; 5100 is a second step
			zoomStarts: [],
			annotationStarts: [],
			narration,
			endMs: 6000,
			coalesceMs: 1500,
		});
		expect(steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
		expect(steps[0].screenshotMs).toBe(100);
		expect(steps[0].transcriptText).toContain("Open the homepage.");
		expect(steps[0].transcriptText).toContain("Click create.");
		expect(steps[1].screenshotMs).toBe(5100);
		expect(steps[1].transcriptText).toBe("Fill in the details.");
	});

	it("falls back to narration starts when there are no interactions", () => {
		const steps = deriveSteps({
			clicks: [],
			zoomStarts: [],
			annotationStarts: [],
			narration,
			endMs: 6000,
			coalesceMs: 1, // don't merge — one step per narration segment
		});
		expect(steps).toHaveLength(3);
		expect(steps[0].screenshotMs).toBe(0);
		expect(steps[2].screenshotMs).toBe(5000);
	});

	it("returns [] when there is nothing to anchor", () => {
		expect(
			deriveSteps({ clicks: [], zoomStarts: [], annotationStarts: [], narration: [], endMs: 0 }),
		).toEqual([]);
	});

	it("caps the number of steps", () => {
		const clicks = Array.from({ length: 100 }, (_, i) => i * 10_000);
		const steps = deriveSteps({
			clicks,
			zoomStarts: [],
			annotationStarts: [],
			narration: [],
			endMs: 1_000_000,
			coalesceMs: 1,
			maxSteps: 20,
		});
		expect(steps.length).toBeLessThanOrEqual(20);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/docExport/steps.test.ts`
Expected: FAIL — `Cannot find module './steps'`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/docExport/steps.ts`:

```ts
import type { DeriveStepsInput, DocStep, NarrationSegment } from "./types";

const DEFAULT_COALESCE_MS = 1500;
const DEFAULT_MAX_STEPS = 20;

/** Merge ascending moments that fall within `windowMs` of the previous kept moment. */
function coalesce(moments: number[], windowMs: number): number[] {
	const out: number[] = [];
	for (const m of moments) {
		if (out.length === 0 || m - out[out.length - 1] >= windowMs) out.push(m);
	}
	return out;
}

function textForSpan(narration: NarrationSegment[], start: number, end: number): string {
	return narration
		.filter((s) => s.sourceEndMs > start && s.sourceStartMs < end)
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join(" ");
}

/**
 * Interaction-anchored step derivation: steps come from clicks + zoom/annotation moments,
 * coalesced so we don't get too many. Falls back to narration-segment starts when a recording
 * has no interactions. Each step spans [anchor, nextAnchor) and carries the narration in that span.
 */
export function deriveSteps(input: DeriveStepsInput): DocStep[] {
	const coalesceMs = input.coalesceMs ?? DEFAULT_COALESCE_MS;
	const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;

	let moments = [...input.clicks, ...input.zoomStarts, ...input.annotationStarts]
		.filter((m) => Number.isFinite(m) && m >= 0)
		.sort((a, b) => a - b);
	if (moments.length === 0) {
		moments = input.narration.map((s) => s.sourceStartMs).sort((a, b) => a - b);
	}
	if (moments.length === 0) return [];

	let windowMs = coalesceMs;
	let anchors = coalesce(moments, windowMs);
	while (anchors.length > maxSteps) {
		windowMs *= 2;
		const next = coalesce(moments, windowMs);
		if (next.length === anchors.length) break; // can't reduce further
		anchors = next;
	}
	if (anchors.length > maxSteps) {
		console.info(`[docExport] capping steps ${anchors.length} -> ${maxSteps}`);
		anchors = anchors.slice(0, maxSteps);
	}

	const steps: DocStep[] = [];
	for (let i = 0; i < anchors.length; i++) {
		const start = anchors[i];
		const end = i + 1 < anchors.length ? anchors[i + 1] : Math.max(input.endMs, start + 1);
		steps.push({
			id: `step-${i + 1}`,
			screenshotMs: start,
			spanStartMs: start,
			spanEndMs: end,
			transcriptText: textForSpan(input.narration, start, end),
		});
	}
	return steps;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/docExport/steps.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/docExport/types.ts src/lib/docExport/steps.ts src/lib/docExport/steps.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): types + interaction-anchored deriveSteps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `validateGeneratedDoc`

**Files:**
- Create: `src/lib/docExport/validateDoc.ts`
- Test: `src/lib/docExport/validateDoc.test.ts`

**Interfaces:**
- Produces: `validateGeneratedDoc(requestedIds: string[], raw: unknown): GeneratedDoc` — throws on any shape/id-set violation; returns steps reordered by `requestedIds`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/docExport/validateDoc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateGeneratedDoc } from "./validateDoc";

const good = {
	title: "Creating a New Ticket in Jira",
	overview: "This guide explains how to create a ticket.",
	audience: ["New users", "PMs"],
	learn: ["How to open the board", "How to create a ticket"],
	steps: [
		{ id: "step-2", heading: "Create", body: "Click **Create**." },
		{ id: "step-1", heading: "Board", body: "Open the board." },
	],
};

describe("validateGeneratedDoc", () => {
	it("accepts a valid doc and reorders steps by requestedIds", () => {
		const doc = validateGeneratedDoc(["step-1", "step-2"], good);
		expect(doc.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
		expect(doc.title).toBe(good.title);
	});

	it("throws on a missing required field", () => {
		expect(() => validateGeneratedDoc(["step-1", "step-2"], { ...good, overview: "" })).toThrow();
	});

	it("throws on an id-set mismatch (extra id)", () => {
		const extra = { ...good, steps: [...good.steps, { id: "step-3", heading: "x", body: "y" }] };
		expect(() => validateGeneratedDoc(["step-1", "step-2"], extra)).toThrow();
	});

	it("throws on a duplicate id", () => {
		const dup = {
			...good,
			steps: [
				{ id: "step-1", heading: "a", body: "b" },
				{ id: "step-1", heading: "c", body: "d" },
			],
		};
		expect(() => validateGeneratedDoc(["step-1", "step-2"], dup)).toThrow();
	});

	it("throws on non-string audience entries", () => {
		expect(() => validateGeneratedDoc(["step-1", "step-2"], { ...good, audience: [1, 2] })).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/docExport/validateDoc.test.ts`
Expected: FAIL — `Cannot find module './validateDoc'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/docExport/validateDoc.ts`:

```ts
import type { GeneratedDoc } from "./types";

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate an AI doc response. Throws unless the doc has the required fields and its steps
 * contain exactly one entry per requested id (no missing/extra/duplicate). Returns steps
 * reordered by `requestedIds` — the all-or-nothing guarantee for the doc.
 */
export function validateGeneratedDoc(requestedIds: string[], raw: unknown): GeneratedDoc {
	if (!raw || typeof raw !== "object") throw new Error("Doc response was not an object.");
	const d = raw as Record<string, unknown>;
	if (!isNonEmptyString(d.title)) throw new Error("Doc missing title.");
	if (!isNonEmptyString(d.overview)) throw new Error("Doc missing overview.");
	if (!isStringArray(d.audience)) throw new Error("Doc audience must be a string array.");
	if (!isStringArray(d.learn)) throw new Error("Doc learn must be a string array.");
	if (!Array.isArray(d.steps)) throw new Error("Doc steps was not an array.");

	const byId = new Map<string, { heading: string; body: string }>();
	for (const item of d.steps) {
		if (!item || typeof item !== "object") throw new Error("Doc step was not an object.");
		const { id, heading, body } = item as { id?: unknown; heading?: unknown; body?: unknown };
		if (typeof id !== "string" || typeof heading !== "string" || typeof body !== "string") {
			throw new Error("Doc step missing string id/heading/body.");
		}
		if (byId.has(id)) throw new Error(`Doc step duplicate id: ${id}`);
		byId.set(id, { heading, body });
	}
	if (byId.size !== requestedIds.length) {
		throw new Error(`Doc step count (${byId.size}) did not match requested (${requestedIds.length}).`);
	}
	const steps = requestedIds.map((id) => {
		const s = byId.get(id);
		if (!s) throw new Error(`Doc missing requested step id: ${id}`);
		return { id, heading: s.heading, body: s.body };
	});
	return { title: d.title, overview: d.overview, audience: d.audience, learn: d.learn, steps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/docExport/validateDoc.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/docExport/validateDoc.ts src/lib/docExport/validateDoc.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): id-set-exact doc validation guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Contracts + client (`docExport` domain) + `renderDocHtml` + barrel

**Files:**
- Modify: `src/native/contracts.ts`
- Modify: `src/native/client.ts`
- Create: `src/lib/docExport/renderHtml.ts`
- Create: `src/lib/docExport/index.ts`
- Test: `src/lib/docExport/renderHtml.test.ts`

**Interfaces:**
- Produces: contract types `DocExportGeneratedDoc`, `DocExportResult`, `DocExportSaveResult`; request members `docExport/generate`, `docExport/save`; `nativeBridgeClient.docExport.generate(...)` / `.save(...)`; `renderDocHtml(doc, screenshotsById): string`.
- Consumes: `GeneratedDoc` from `./types`.

- [ ] **Step 1: Add the contract types + request members**

In `src/native/contracts.ts`, after the `ScriptPolishKeyResult` interface (line ~132) add:

```ts
export interface DocExportGeneratedDoc {
	title: string;
	overview: string;
	audience: string[];
	learn: string[];
	steps: { id: string; heading: string; body: string }[];
}

export interface DocExportResult {
	success: boolean;
	doc?: DocExportGeneratedDoc;
	message?: string;
	code?: "no-key" | "api-error" | "invalid-response";
}

export interface DocExportSaveResult {
	success: boolean;
	path?: string;
	canceled?: boolean;
	message?: string;
}
```

Then, in the `NativeBridgeRequest` union, after the `scriptPolish/clearKey` member (line ~316) add:

```ts
	| {
			domain: "docExport";
			action: "generate";
			payload: {
				steps: { id: string; transcriptText: string; imageDataUrl: string }[];
				context: { transcript: string };
			};
			requestId?: string;
	  }
	| {
			domain: "docExport";
			action: "save";
			payload: { html: string };
			requestId?: string;
	  }
```

- [ ] **Step 2: Add the client block**

In `src/native/client.ts`, add the two types to the import from `./contracts` (line 1–19): `type DocExportResult,` and `type DocExportSaveResult,`. Then after the `scriptPolish: { … }` block (line ~199) add:

```ts
	docExport: {
		generate: (
			steps: { id: string; transcriptText: string; imageDataUrl: string }[],
			context: { transcript: string },
		) =>
			requireNativeBridgeData<DocExportResult>({
				domain: "docExport",
				action: "generate",
				payload: { steps, context },
			}),
		save: (html: string) =>
			requireNativeBridgeData<DocExportSaveResult>({
				domain: "docExport",
				action: "save",
				payload: { html },
			}),
	},
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). This confirms `src/lib/docExport/types.ts`'s `DocExportGeneratedDoc` import now resolves.

- [ ] **Step 4: Write the failing renderHtml test**

Create `src/lib/docExport/renderHtml.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderDocHtml } from "./renderHtml";
import type { GeneratedDoc } from "./types";

const doc: GeneratedDoc = {
	title: "Creating a <New> Ticket",
	overview: "This explains **ticket** creation.",
	audience: ["New users"],
	learn: ["How to create a ticket"],
	steps: [
		{ id: "step-1", heading: "Open the board", body: "Click **Board view**." },
		{ id: "step-2", heading: "Create", body: "Press Create." },
	],
};

describe("renderDocHtml", () => {
	it("inlines screenshots as base64 data URIs and never references external files", () => {
		const shots = new Map([
			["step-1", "data:image/png;base64,AAA1"],
			["step-2", "data:image/png;base64,AAA2"],
		]);
		const html = renderDocHtml(doc, shots);
		expect(html).toContain('src="data:image/png;base64,AAA1"');
		expect(html).toContain('src="data:image/png;base64,AAA2"');
		expect(html).not.toMatch(/src="https?:/);
		expect(html).not.toMatch(/src="\.\//);
	});

	it("escapes HTML in model text but renders **bold**", () => {
		const html = renderDocHtml(doc, new Map());
		expect(html).toContain("Creating a &lt;New&gt; Ticket");
		expect(html).toContain("<strong>ticket</strong>");
		expect(html).toContain("<strong>Board view</strong>");
	});

	it("emits the section structure in order", () => {
		const html = renderDocHtml(doc, new Map());
		expect(html.indexOf("Who This Guide Is For")).toBeGreaterThan(html.indexOf("<h1>"));
		expect(html.indexOf("What You&#39;ll Learn")).toBeGreaterThan(
			html.indexOf("Who This Guide Is For"),
		);
		expect(html.indexOf("Step-by-Step Instructions")).toBeGreaterThan(
			html.indexOf("What You&#39;ll Learn"),
		);
	});
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/lib/docExport/renderHtml.test.ts`
Expected: FAIL — `Cannot find module './renderHtml'`.

- [ ] **Step 6: Write the implementation**

Create `src/lib/docExport/renderHtml.ts`:

```ts
import type { GeneratedDoc } from "./types";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Escape, then render a safe **bold** subset for UI-element emphasis. */
function inlineMarkup(s: string): string {
	return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const STYLE = `
:root { color-scheme: light; }
body { max-width: 820px; margin: 0 auto; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6; }
h1 { font-size: 2.2rem; font-weight: 800; margin: 0 0 1.5rem; }
h2 { font-size: 1.4rem; font-weight: 700; margin: 2rem 0 0.75rem; }
.overview { background: #f5f8ff; border-left: 4px solid #4f7cff; border-radius: 6px; padding: 1rem 1.25rem; margin: 1rem 0 1.5rem; }
.overview p { margin: 0; }
ul { padding-left: 1.25rem; }
.step { margin: 1.5rem 0; }
figure { margin: 0.75rem 0 0; }
img { display: block; max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e2e8f0; }
`.trim();

/**
 * Assemble a self-contained HTML walkthrough. Screenshots are inlined as data URIs so images
 * can never break regardless of where the file is opened.
 */
export function renderDocHtml(doc: GeneratedDoc, screenshotsById: Map<string, string>): string {
	const listItems = (items: string[]) =>
		items.map((x) => `<li>${inlineMarkup(x)}</li>`).join("");
	const steps = doc.steps
		.map((s) => {
			const img = screenshotsById.get(s.id);
			const figure = img
				? `<figure><img alt="${escapeHtml(s.heading)}" src="${img}" /></figure>`
				: "";
			return `<section class="step"><h2>${inlineMarkup(s.heading)}</h2><p>${inlineMarkup(s.body)}</p>${figure}</section>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
<div class="overview"><p>${inlineMarkup(doc.overview)}</p></div>
<h2>Who This Guide Is For</h2>
<ul>${listItems(doc.audience)}</ul>
<h2>What You'll Learn</h2>
<ul>${listItems(doc.learn)}</ul>
<h2>Step-by-Step Instructions</h2>
${steps}
</body>
</html>`;
}
```

- [ ] **Step 7: Create the barrel**

Create `src/lib/docExport/index.ts`:

```ts
export { deriveSteps } from "./steps";
export { renderDocHtml } from "./renderHtml";
export { validateGeneratedDoc } from "./validateDoc";
export type {
	DeriveStepsInput,
	DocStep,
	DocStepInput,
	GeneratedDoc,
	GeneratedDocStep,
	NarrationSegment,
} from "./types";
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run src/lib/docExport/renderHtml.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/native/contracts.ts src/native/client.ts src/lib/docExport/renderHtml.ts src/lib/docExport/renderHtml.test.ts src/lib/docExport/index.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): contracts, client, self-contained HTML renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `DocExportService` (multimodal generate + save) + transport wiring

**Files:**
- Create: `electron/native-bridge/services/docExportService.ts`
- Test: `electron/native-bridge/services/docExportService.test.ts`
- Modify: `electron/ipc/nativeBridge.ts`
- Modify: `electron/ipc/handlers.ts`

**Interfaces:**
- Produces: `class DocExportService` with `generate(steps, context): Promise<DocExportResult>` and `save(html): Promise<DocExportSaveResult>`. Constructor: `new DocExportService({ keyStore, fetchImpl?, showSaveDialog?, renderPdf? })`.
- Consumes: `OpenAiKeyStore` (Task 1); contract types.

- [ ] **Step 1: Write the failing test**

Create `electron/native-bridge/services/docExportService.test.ts`:

```ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DocExportService } from "./docExportService";
import { OpenAiKeyStore } from "./openAiKeyStore";

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
	decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
};

async function keyStoreWithKey() {
	const dir = await mkdtemp(path.join(tmpdir(), "doc-key-"));
	const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
	await store.setKey("sk-test");
	return store;
}

const steps = [
	{ id: "step-1", transcriptText: "Open the board.", imageDataUrl: "data:image/png;base64,AAA" },
];

const goodCompletion = {
	choices: [
		{
			message: {
				content: JSON.stringify({
					title: "T",
					overview: "O",
					audience: ["a"],
					learn: ["l"],
					steps: [{ id: "step-1", heading: "H", body: "B" }],
				}),
			},
		},
	],
};

describe("DocExportService.generate", () => {
	it("returns no-key when no key is set", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "doc-key-"));
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		const svc = new DocExportService({ keyStore: store, fetchImpl: vi.fn() });
		const res = await svc.generate(steps, { transcript: "…" });
		expect(res.code).toBe("no-key");
	});

	it("sends a multimodal request (image + text) and returns the parsed doc", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify(goodCompletion), { status: 200 }),
		) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		const res = await svc.generate(steps, { transcript: "full transcript" });

		expect(res.success).toBe(true);
		expect(res.doc?.title).toBe("T");
		const body = JSON.parse((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1].body);
		expect(body.model).toBe("gpt-4o-mini");
		const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
		const parts = userMsg.content as { type: string; image_url?: { url: string } }[];
		expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image"))).toBe(true);
		expect(parts.some((p) => p.type === "text")).toBe(true);
	});

	it("maps a non-2xx response to api-error", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		expect((await svc.generate(steps, { transcript: "x" })).code).toBe("api-error");
	});

	it("maps bad JSON to invalid-response", async () => {
		const bad = { choices: [{ message: { content: "not json" } }] };
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bad), { status: 200 })) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		expect((await svc.generate(steps, { transcript: "x" })).code).toBe("invalid-response");
	});
});

describe("DocExportService.save", () => {
	it("writes .html and .pdf to the chosen path", async () => {
		const outDir = await mkdtemp(path.join(tmpdir(), "doc-out-"));
		const target = path.join(outDir, "walkthrough.html");
		const svc = new DocExportService({
			keyStore: await keyStoreWithKey(),
			showSaveDialog: async () => ({ canceled: false, filePath: target }),
			renderPdf: async () => Buffer.from("%PDF-1.4 fake"),
		});
		const res = await svc.save("<html><body>hi</body></html>");
		expect(res.success).toBe(true);
		const files = await readdir(outDir);
		expect(files).toContain("walkthrough.html");
		expect(files).toContain("walkthrough.pdf");
		expect(await readFile(target, "utf8")).toContain("hi");
	});

	it("returns canceled when the dialog is dismissed", async () => {
		const svc = new DocExportService({
			keyStore: await keyStoreWithKey(),
			showSaveDialog: async () => ({ canceled: true }),
			renderPdf: async () => Buffer.from(""),
		});
		expect((await svc.save("<html></html>")).canceled).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/native-bridge/services/docExportService.test.ts`
Expected: FAIL — `Cannot find module './docExportService'`.

- [ ] **Step 3: Write the implementation**

Create `electron/native-bridge/services/docExportService.ts`:

```ts
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocExportResult, DocExportSaveResult } from "../../../src/native/contracts";
import type { OpenAiKeyStore } from "./openAiKeyStore";

const DOC_EXPORT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

type SaveDialogFn = (options: {
	title?: string;
	defaultPath?: string;
	filters?: { name: string; extensions: string[] }[];
}) => Promise<{ canceled: boolean; filePath?: string }>;

type RenderPdfFn = (html: string) => Promise<Buffer>;

interface DocExportServiceOptions {
	keyStore: OpenAiKeyStore;
	fetchImpl?: typeof fetch;
	showSaveDialog?: SaveDialogFn;
	renderPdf?: RenderPdfFn;
}

/** Default PDF renderer: offscreen window → printToPDF (main-process only). */
async function defaultRenderPdf(html: string): Promise<Buffer> {
	const { BrowserWindow } = await import("electron");
	const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
	const tmp = path.join(tmpdir(), `docexport-${Date.now()}-${process.pid}.html`);
	try {
		await writeFile(tmp, html, "utf8");
		await win.loadFile(tmp);
		return await win.webContents.printToPDF({ printBackground: true });
	} finally {
		win.destroy();
		await rm(tmp, { force: true });
	}
}

async function defaultShowSaveDialog(options: Parameters<SaveDialogFn>[0]) {
	const { dialog } = await import("electron");
	return dialog.showSaveDialog(options);
}

/**
 * Main-process Doc Export: one multimodal OpenAI call (vision + transcript) to generate the
 * document, and file save (self-contained HTML + PDF). Reads the shared OpenAI key.
 */
export class DocExportService {
	private readonly keyStore: OpenAiKeyStore;
	private readonly fetchImpl: typeof fetch;
	private readonly showSaveDialog: SaveDialogFn;
	private readonly renderPdf: RenderPdfFn;

	constructor(options: DocExportServiceOptions) {
		this.keyStore = options.keyStore;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.showSaveDialog = options.showSaveDialog ?? defaultShowSaveDialog;
		this.renderPdf = options.renderPdf ?? defaultRenderPdf;
	}

	async generate(
		steps: { id: string; transcriptText: string; imageDataUrl: string }[],
		context: { transcript: string },
	): Promise<DocExportResult> {
		const key = await this.keyStore.readKey();
		if (!key) return { success: false, code: "no-key", message: "No OpenAI API key set." };

		const system = [
			"You write clear product-walkthrough documentation from a screen recording.",
			"You are given the full narration transcript and, per step, its narration plus a screenshot of the screen at that moment.",
			"Describe the page being looked at and the exact click-guide; bold the real on-screen UI elements the user interacts with using **double asterisks**.",
			'Return ONLY JSON of the form {"title":string,"overview":string,"audience":string[],"learn":string[],"steps":[{"id":string,"heading":string,"body":string}]}.',
			"Produce exactly one step object per provided step id — do not add, drop, merge, or rename ids.",
		].join(" ");

		const userContent: unknown[] = [
			{ type: "text", text: `Full transcript:\n${context.transcript}` },
		];
		for (const s of steps) {
			userContent.push({ type: "text", text: `Step id ${s.id}. Narration: ${s.transcriptText}` });
			userContent.push({ type: "image_url", image_url: { url: s.imageDataUrl, detail: "high" } });
		}

		let response: Response;
		try {
			response = await this.fetchImpl(OPENAI_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: DOC_EXPORT_MODEL,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: userContent },
					],
				}),
				signal: AbortSignal.timeout(120_000),
			});
		} catch (error) {
			return {
				success: false,
				code: "api-error",
				message: error instanceof Error ? error.message : String(error),
			};
		}

		if (!response.ok) {
			return {
				success: false,
				code: "api-error",
				message: `OpenAI request failed (${response.status}).`,
			};
		}

		try {
			const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
			const content = body.choices?.[0]?.message?.content;
			if (!content) return { success: false, code: "invalid-response", message: "Empty completion." };
			const doc = JSON.parse(content) as DocExportResult["doc"];
			if (!doc || typeof doc !== "object" || !Array.isArray(doc.steps)) {
				return { success: false, code: "invalid-response", message: "Malformed doc JSON." };
			}
			return { success: true, doc };
		} catch (error) {
			return {
				success: false,
				code: "invalid-response",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async save(html: string): Promise<DocExportSaveResult> {
		const chosen = await this.showSaveDialog({
			title: "Export walkthrough",
			defaultPath: "walkthrough.html",
			filters: [{ name: "HTML", extensions: ["html"] }],
		});
		if (chosen.canceled || !chosen.filePath) return { success: false, canceled: true };

		const htmlPath = chosen.filePath.endsWith(".html") ? chosen.filePath : `${chosen.filePath}.html`;
		try {
			await writeFile(htmlPath, html, "utf8");
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
		try {
			const pdf = await this.renderPdf(html);
			await writeFile(htmlPath.replace(/\.html$/, ".pdf"), pdf);
		} catch (error) {
			// PDF is best-effort; the HTML already saved.
			console.warn("[DocExportService] PDF render failed:", error);
		}
		return { success: true, path: htmlPath };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/native-bridge/services/docExportService.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the shared key store + docExport into the transport**

In `electron/ipc/nativeBridge.ts`:

(a) Add imports near the other service imports (line ~16):

```ts
import { DocExportService } from "../native-bridge/services/docExportService";
import { OpenAiKeyStore } from "../native-bridge/services/openAiKeyStore";
```

(b) Add to `NativeBridgeContext` (after `getScriptPolishConfigDir`, line ~46):

```ts
	getOpenAiConfigDir: () => string;
	getLegacyScriptPolishConfigDir: () => string;
```

(c) Replace the `scriptPolishService` construction (lines 132–134) with a shared store feeding both services:

```ts
	const openAiKeyStore = new OpenAiKeyStore({
		configDir: context.getOpenAiConfigDir(),
		legacyDir: context.getLegacyScriptPolishConfigDir(),
	});
	const scriptPolishService = new ScriptPolishService({ keyStore: openAiKeyStore });
	const docExportService = new DocExportService({ keyStore: openAiKeyStore });
```

(d) Add a `docExport` dispatch case right after the `scriptPolish` case's closing brace (line ~337):

```ts
				case "docExport": {
					const action = request.action as string;
					switch (request.action) {
						case "generate":
							return createSuccessResponse(
								requestId,
								await docExportService.generate(
									request.payload.steps,
									request.payload.context,
								),
							);
						case "save":
							return createSuccessResponse(
								requestId,
								await docExportService.save(request.payload.html),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported docExport action: ${action}`,
							);
					}
				}
```

- [ ] **Step 6: Provide the context dirs in `handlers.ts`**

In `electron/ipc/handlers.ts`, in the `registerNativeBridgeHandlers({ … })` literal (lines ~2899–2919), replace the `getScriptPolishConfigDir` line with:

```ts
		getOpenAiConfigDir: () => path.join(app.getPath("userData"), "openai"),
		getLegacyScriptPolishConfigDir: () => path.join(app.getPath("userData"), "script-polish"),
```

(The old `getScriptPolishConfigDir` field is no longer referenced by the transport — remove it from the literal and from `NativeBridgeContext`.)

- [ ] **Step 7: Typecheck + run main-process tests**

Run: `npx tsc --noEmit && npx vitest run electron/native-bridge/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add electron/native-bridge/services/docExportService.ts electron/native-bridge/services/docExportService.test.ts electron/ipc/nativeBridge.ts electron/ipc/handlers.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): main-process generate + save service and transport

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `useDocExport` orchestration hook

**Files:**
- Create: `src/hooks/useDocExport.ts`
- Test: `src/hooks/useDocExport.test.ts`

**Interfaces:**
- Produces: `useDocExport(params: UseDocExportParams): UseDocExportResult`.
  - `UseDocExportParams`: `{ hasTranscript: boolean; getFullTranscriptText: () => string; getDeriveInputs: () => DeriveStepsInput; getScreenshotConfig: () => DocScreenshotConfig | null }`.
  - `UseDocExportResult`: `{ status: DocExportStatus; hasKey: boolean; refreshKeyStatus: () => Promise<void>; exportDoc: () => Promise<void> }`.
  - `DocExportStatus`: `{ state: "idle" | "capturing" | "generating" | "rendering" | "saving" } | { state: "error"; message: string }`.
- Consumes: `deriveSteps`, `validateGeneratedDoc`, `renderDocHtml` (Tasks 3–5); `captureStepScreenshots` + `DocScreenshotConfig` (Task 2); `nativeBridgeClient.docExport.*` and `nativeBridgeClient.scriptPolish.getKeyStatus` (the shared key).

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useDocExport.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeriveStepsInput } from "@/lib/docExport/types";
import { useDocExport } from "./useDocExport";

vi.mock("@/lib/docExport/screenshots", () => ({
	captureStepScreenshots: vi.fn(async (_config, times: number[]) =>
		times.map((_, i) => `data:image/png;base64,SHOT${i}`),
	),
}));

const generate = vi.fn();
const save = vi.fn();
const getKeyStatus = vi.fn(async () => ({ hasKey: true }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		docExport: { generate: (...a: unknown[]) => generate(...a), save: (...a: unknown[]) => save(...a) },
		scriptPolish: { getKeyStatus: () => getKeyStatus() },
	},
}));

const inputs: DeriveStepsInput = {
	clicks: [100, 5000],
	zoomStarts: [],
	annotationStarts: [],
	narration: [
		{ sourceStartMs: 0, sourceEndMs: 900, text: "Open the board." },
		{ sourceStartMs: 5000, sourceEndMs: 5900, text: "Create a ticket." },
	],
	endMs: 6000,
	coalesceMs: 1500,
};

const params = {
	hasTranscript: true,
	getFullTranscriptText: () => "full transcript",
	getDeriveInputs: () => inputs,
	getScreenshotConfig: () => ({ videoUrl: "x", frameRate: 15 }) as never,
};

beforeEach(() => {
	generate.mockReset();
	save.mockReset();
});

describe("useDocExport", () => {
	it("runs capture → generate → render → save on success", async () => {
		generate.mockResolvedValue({
			success: true,
			doc: {
				title: "T",
				overview: "O",
				audience: ["a"],
				learn: ["l"],
				steps: [
					{ id: "step-1", heading: "H1", body: "B1" },
					{ id: "step-2", heading: "H2", body: "B2" },
				],
			},
		});
		save.mockResolvedValue({ success: true, path: "/tmp/walkthrough.html" });

		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});

		expect(generate).toHaveBeenCalledTimes(1);
		const [sentSteps] = generate.mock.calls[0];
		expect(sentSteps).toHaveLength(2);
		expect(sentSteps[0].imageDataUrl).toBe("data:image/png;base64,SHOT0");
		const [html] = save.mock.calls[0];
		expect(html).toContain("<strong>"); // rendered doc
		expect(result.current.status.state).toBe("idle");
	});

	it("aborts atomically on an id-set mismatch (no save)", async () => {
		generate.mockResolvedValue({
			success: true,
			doc: {
				title: "T",
				overview: "O",
				audience: ["a"],
				learn: ["l"],
				steps: [{ id: "step-1", heading: "H", body: "B" }], // missing step-2
			},
		});
		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});
		expect(save).not.toHaveBeenCalled();
		expect(result.current.status.state).toBe("error");
	});

	it("surfaces no-key without saving", async () => {
		generate.mockResolvedValue({ success: false, code: "no-key" });
		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});
		expect(save).not.toHaveBeenCalled();
		await waitFor(() => expect(result.current.hasKey).toBe(false));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useDocExport.test.ts`
Expected: FAIL — `Cannot find module './useDocExport'`.

- [ ] **Step 3: Write the implementation**

Create `src/hooks/useDocExport.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { deriveSteps, renderDocHtml, validateGeneratedDoc } from "@/lib/docExport";
import { captureStepScreenshots, type DocScreenshotConfig } from "@/lib/docExport/screenshots";
import type { DeriveStepsInput } from "@/lib/docExport/types";
import { nativeBridgeClient } from "@/native/client";

export type DocExportStatus =
	| { state: "idle" | "capturing" | "generating" | "rendering" | "saving" }
	| { state: "error"; message: string };

export interface UseDocExportParams {
	hasTranscript: boolean;
	getFullTranscriptText: () => string;
	getDeriveInputs: () => DeriveStepsInput;
	getScreenshotConfig: () => DocScreenshotConfig | null;
}

export interface UseDocExportResult {
	status: DocExportStatus;
	hasKey: boolean;
	refreshKeyStatus: () => Promise<void>;
	exportDoc: () => Promise<void>;
}

/**
 * Orchestrates Doc Export: deriveSteps → capture screenshots → multimodal generate → validate →
 * render self-contained HTML → save. Any failure aborts the whole run (nothing is written).
 */
export function useDocExport(params: UseDocExportParams): UseDocExportResult {
	const { getFullTranscriptText, getDeriveInputs, getScreenshotConfig } = params;
	const [status, setStatus] = useState<DocExportStatus>({ state: "idle" });
	const [hasKey, setHasKey] = useState(false);

	const refreshKeyStatus = useCallback(async () => {
		try {
			const { hasKey: present } = await nativeBridgeClient.scriptPolish.getKeyStatus();
			setHasKey(present);
		} catch (error) {
			console.warn("[useDocExport] key status failed:", error);
			setHasKey(false);
		}
	}, []);

	useEffect(() => {
		void refreshKeyStatus();
	}, [refreshKeyStatus]);

	const exportDoc = useCallback(async () => {
		try {
			const steps = deriveSteps(getDeriveInputs());
			if (steps.length === 0) {
				setStatus({ state: "error", message: "not-enough" });
				return;
			}
			const config = getScreenshotConfig();
			if (!config) {
				setStatus({ state: "error", message: "no-video" });
				return;
			}

			setStatus({ state: "capturing" });
			const shots = await captureStepScreenshots(config, steps.map((s) => s.screenshotMs));

			setStatus({ state: "generating" });
			const stepInputs = steps.map((s, i) => ({
				id: s.id,
				transcriptText: s.transcriptText,
				imageDataUrl: shots[i],
			}));
			const res = await nativeBridgeClient.docExport.generate(stepInputs, {
				transcript: getFullTranscriptText(),
			});
			if (!res.success) {
				if (res.code === "no-key") setHasKey(false);
				setStatus({ state: "error", message: res.code ?? res.message ?? "generate-failed" });
				return;
			}

			const doc = validateGeneratedDoc(
				steps.map((s) => s.id),
				res.doc,
			);

			setStatus({ state: "rendering" });
			const byId = new Map(steps.map((s, i) => [s.id, shots[i]]));
			const html = renderDocHtml(doc, byId);

			setStatus({ state: "saving" });
			const saveRes = await nativeBridgeClient.docExport.save(html);
			if (saveRes.canceled) {
				setStatus({ state: "idle" });
				return;
			}
			if (!saveRes.success) {
				setStatus({ state: "error", message: saveRes.message ?? "save-failed" });
				return;
			}
			setStatus({ state: "idle" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[useDocExport] export failed:", message);
			setStatus({ state: "error", message });
		}
	}, [getDeriveInputs, getScreenshotConfig, getFullTranscriptText]);

	return { status, hasKey, refreshKeyStatus, exportDoc };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useDocExport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDocExport.ts src/hooks/useDocExport.test.ts
git commit -m "$(cat <<'EOF'
feat(doc-export): useDocExport orchestration hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: i18n — `docExport` namespace across all 13 locales

**Files:**
- Create: `src/i18n/locales/<locale>/docExport.json` × 13
- Modify: `src/i18n/config.ts`

**Interfaces:**
- Produces: the `docExport` namespace with keys `title`, `button`, `busy`, `disclosure`, `addKey`, `noTranscript`, `notEnough`, `saved`, `failed`.

- [ ] **Step 1: Create the English baseline**

Create `src/i18n/locales/en/docExport.json`:

```json
{
	"title": "Doc export",
	"button": "Export doc",
	"busy": "Building doc…",
	"disclosure": "The transcript and screenshots from this recording are sent to OpenAI to generate the document.",
	"addKey": "Add OpenAI key",
	"noTranscript": "Record or open a video with speech — the document is generated from its transcript.",
	"notEnough": "Not enough in this recording to build a walkthrough.",
	"saved": "Walkthrough saved",
	"failed": "Doc export failed"
}
```

- [ ] **Step 2: Register the namespace**

In `src/i18n/config.ts`, add `"docExport"` to the namespaces array (the one containing `"voiceover"` at line ~25). If there is a `REQUIRED_NAMESPACES` list and/or an `I18nNamespace` union type in that file, add `"docExport"` there too so `useScopedT("docExport")` typechecks.

- [ ] **Step 3: Create the 12 other locales**

Create `src/i18n/locales/<locale>/docExport.json` for each of `ar, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW`, with the same keys as `en` and professionally translated values (match tone/terminology of the existing `voiceover.json` in each locale). Keys must be identical to `en`.

- [ ] **Step 4: Verify locale parity**

Run: `npm run i18n:check`
Expected: PASS — no missing keys/namespaces vs `en`.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/config.ts src/i18n/locales/*/docExport.json
git commit -m "$(cat <<'EOF'
feat(doc-export): add docExport i18n namespace (13 locales)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: UI — "Export doc" in SettingsPanel + wire `useDocExport` in VideoEditor

**Files:**
- Modify: `src/components/video-editor/SettingsPanel.tsx`
- Modify: `src/components/video-editor/VideoEditor.tsx`

**Interfaces:**
- Consumes: `useDocExport` (Task 7); the existing `<OpenAiKeyDialog>` + `openAiKeyDialogOpen` state already in `VideoEditor` (from Script Polish); the existing editor state used to build export config at `VideoEditor.tsx:2194` (`videoPath`, `zoomRegions`, `cursorRecordingData`, `effectiveAnnotationRegions`, transcript, `voiceover.segments`, etc.).
- Produces: SettingsPanel props `onExportDoc?: () => void`, `canExportDoc?: boolean`, `docExportBusy?: boolean`, `hasOpenAiKey?: boolean`, `onAddOpenAiKey?: () => void`.

- [ ] **Step 1: Add the SettingsPanel props + button**

In `src/components/video-editor/SettingsPanel.tsx`, add to the props interface (near `onExport?: () => void;`, line ~299):

```ts
	onExportDoc?: () => void;
	canExportDoc?: boolean;
	docExportBusy?: boolean;
	hasOpenAiKey?: boolean;
	onAddOpenAiKey?: () => void;
```

Destructure them alongside `onExport` (line ~449). Add `useScopedT` for the new namespace at the top of the component body:

```ts
	const dt = useScopedT("docExport");
```

Then, right after the existing Export button block (around line ~2202), add:

```tsx
	{onExportDoc ? (
		<div className="mt-2 flex flex-col gap-1">
			{hasOpenAiKey ? (
				<Button
					type="button"
					variant="secondary"
					disabled={!canExportDoc || docExportBusy}
					onClick={onExportDoc}
				>
					{docExportBusy ? dt("busy") : dt("button")}
				</Button>
			) : (
				<Button type="button" variant="secondary" onClick={onAddOpenAiKey}>
					{dt("addKey")}
				</Button>
			)}
			<p className="text-[11px] leading-tight text-slate-400">{dt("disclosure")}</p>
			{!canExportDoc ? (
				<p className="text-[11px] leading-tight text-slate-400">{dt("noTranscript")}</p>
			) : null}
		</div>
	) : null}
```

(If `useScopedT` / `Button` are not yet imported in this file, add them: `import { useScopedT } from "@/contexts/I18nContext";` and the existing `Button` import.)

- [ ] **Step 2: Wire `useDocExport` in VideoEditor**

In `src/components/video-editor/VideoEditor.tsx`:

(a) Import the hook near the other hook imports:

```ts
import { useDocExport } from "@/hooks/useDocExport";
import { segmentTranscript } from "@/lib/voiceover/segmentation";
```

(b) Instantiate the hook where other editor hooks are set up (near `useScriptPolish`, line ~367). Build its inputs from existing editor state — clicks come from `cursorRecordingData.samples`, narration prefers `voiceover.segments` else `segmentTranscript(transcript.segments)`:

```ts
	const {
		status: docExportStatus,
		hasKey: hasDocExportKey,
		refreshKeyStatus: refreshDocExportKey,
		exportDoc,
	} = useDocExport({
		hasTranscript: transcript != null,
		getFullTranscriptText: () =>
			(transcript?.segments ?? []).map((s) => s.text).join(" "),
		getDeriveInputs: () => {
			const narration =
				voiceover.segments.length > 0
					? voiceover.segments.map((s) => ({
							sourceStartMs: s.sourceStartMs,
							sourceEndMs: s.sourceEndMs,
							text: s.text,
						}))
					: segmentTranscript(transcript?.segments ?? []).map((d) => ({
							sourceStartMs: d.sourceStartMs,
							sourceEndMs: d.sourceEndMs,
							text: d.text,
						}));
			const clicks = (cursorRecordingData?.samples ?? [])
				.filter((s) => s.interactionType === "click")
				.map((s) => s.timeMs);
			return {
				clicks,
				zoomStarts: zoomRegions.map((z) => z.startMs),
				annotationStarts: effectiveAnnotationRegions
					.filter((a) => a.annotationSource !== "auto-caption")
					.map((a) => a.startMs),
				narration,
				endMs: Math.max(
					0,
					...narration.map((n) => n.sourceEndMs),
					...zoomRegions.map((z) => z.endMs),
				),
			};
		},
		getScreenshotConfig: () =>
			videoPath
				? {
						videoUrl: videoPath,
						frameRate: 30,
						width: exportWidth,
						height: exportHeight,
						wallpaper,
						zoomRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						borderRadius,
						padding,
						cropRegion,
						cursorRecordingData,
						cursorScale: effectiveShowCursor ? cursorSize : 0,
						cursorSmoothing,
						cursorMotionBlur,
						cursorClickBounce,
						cursorClipToBounds,
						cursorTheme,
						annotationRegions: effectiveAnnotationRegions,
						cursorTelemetry,
						cursorClickTimestamps,
					}
				: null,
	});
```

> The `getScreenshotConfig` object mirrors the `VideoExporter` config assembled at `VideoEditor.tsx:2194`. Copy the exact identifiers used there for this editor's state; only `frameRate` and the `videoUrl` differ. If any field name here doesn't match a variable in scope, use the one from line 2194.

(c) On the AI-key dialog's `onKeyStatusChange`, also refresh Doc Export's key (find the `<OpenAiKeyDialog … onKeyStatusChange={…}>`, ~line 3190, and add `void refreshDocExportKey();` next to the existing script-polish refresh).

(d) Show a saved/failed toast by watching `docExportStatus` (near other effects):

```ts
	useEffect(() => {
		if (docExportStatus.state === "error" && docExportStatus.message !== "not-enough") {
			toast.error(dt("failed"));
		}
	}, [docExportStatus, dt]);
```

Add `const dt = useScopedT("docExport");` in VideoEditor if not present.

(e) Pass the new props to `<SettingsPanel …>` (near `onExport={handleOpenExportDialog}`, line ~3012):

```tsx
	onExportDoc={exportDoc}
	canExportDoc={transcript != null}
	docExportBusy={docExportStatus.state !== "idle" && docExportStatus.state !== "error"}
	hasOpenAiKey={hasDocExportKey}
	onAddOpenAiKey={() => setOpenAiKeyDialogOpen(true)}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS. Fix any name mismatches against the real variables in scope at `VideoEditor.tsx:2194`.

- [ ] **Step 4: Manual smoke (dev)**

Run: `npm run dev`. Open a recording with speech, wait for the transcript, confirm the "Export doc" button appears in the export panel (and "Add OpenAI key" when no key). With a key set, click Export doc → it captures, calls OpenAI, and opens a save dialog → the saved `.html` opens with inline screenshots and the `.pdf` exists next to it.

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/SettingsPanel.tsx src/components/video-editor/VideoEditor.tsx
git commit -m "$(cat <<'EOF'
feat(doc-export): Export doc button + editor wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full green gate + docs

**Files:**
- Modify: `README.md` (feature list), if it enumerates AI features
- Modify: `electron/CLAUDE.md` (native-bridge domains list — add `docExport`)

- [ ] **Step 1: Run the full pre-PR gate**

Run: `npm run lint && npx tsc --noEmit && npm run test && npm run test:browser && npm run i18n:check`
Expected: ALL PASS.

- [ ] **Step 2: Update the native-bridge domain note**

In `electron/CLAUDE.md`, in the "Two IPC styles" section that lists current domains (`transcript`, `scriptPolish`, …), add `docExport` (main-process multimodal OpenAI doc generation + HTML/PDF save; shares the OpenAI key via `OpenAiKeyStore`).

- [ ] **Step 3: Update README (if it lists AI features)**

Add a one-line "AI Doc Export" entry mirroring the AI Script Polish entry style.

- [ ] **Step 4: Commit**

```bash
git add README.md electron/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(doc-export): document Doc Export domain + feature

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (against `2026-07-08-ai-doc-export-design.md`):
- Decision 1 multimodal → Task 6 `generate` (image + text parts). ✅
- Decision 2 interaction-anchored steps → Task 3 `deriveSteps`. ✅
- Decision 3 narration fallback → Task 3 (fallback branch + test). ✅
- Decision 4 self-contained HTML + PDF → Task 5 `renderDocHtml` (inline base64) + Task 6 `save` (printToPDF). ✅
- Decision 5 gating on transcript → Task 9 (`canExportDoc={transcript != null}`, `noTranscript` string). ✅
- Decision 6 shared key via `OpenAiKeyStore` → Task 1 + Task 6 wiring. ✅
- Decision 7 Export-panel placement → Task 9 (SettingsPanel). ✅
- Decision 8 batched multimodal + atomic validation → Task 6 (one call) + Task 4 guard + Task 7 (validate before save). ✅
- Decision 9 composited screenshots, linear pass → Task 2. ✅
- Privacy disclosure → Task 8 `disclosure` string + Task 9 render. ✅
- i18n 13 locales → Task 8. ✅
- Testing tiers (unit + browser) → each task's tests; browser tier in Task 2. ✅

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". The only non-verbatim content is (a) the 12 non-English translations (Task 8 Step 3 — localization work, verified by `i18n:check`) and (b) matching exact in-scope variable names at `VideoEditor.tsx:2194` (Task 9 — anchored to a specific line, with a fallback instruction), both legitimate.

**Type consistency:** `OpenAiKeyStore` (Task 1) ← `ScriptPolishService`/`DocExportService` (Tasks 1, 6). `DocExportGeneratedDoc` (contracts, Task 5) = `GeneratedDoc` (types, Task 3) — one source of truth; used by `validateGeneratedDoc` (Task 4), `renderDocHtml` (Task 5), `DocExportResult.doc` (Task 6). `DocScreenshotConfig` (Task 2) consumed by `useDocExport` (Task 7) and produced by `getScreenshotConfig` (Task 9). `DeriveStepsInput`/`DocStep` (Task 3) flow into Task 7. `docExport.generate/save` client (Task 5) ↔ dispatch (Task 6) ↔ hook (Task 7). Consistent.
