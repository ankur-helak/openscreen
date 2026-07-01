# AI Voiceover — Plan 1: TTS Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-device text-to-speech engine (Kokoro via `kokoro-js`) behind a `TtsProvider` interface, running in a reusable Web Worker, and validate the `@huggingface/transformers` / Vite / bundling integration.

**Architecture:** Mirror the existing on-device Whisper captioning setup (`src/lib/captioning/`). A new `src/lib/tts/` layer exposes a `TtsProvider` interface; a `KokoroProvider` owns a long-lived Web Worker that loads the Kokoro model once and synthesizes speech per request. Dev loads the model from the HuggingFace CDN; the packaged app loads bundled assets from `tts-assets/` (offline, under `file://`), exactly like `caption-assets/`.

**Tech Stack:** TypeScript, Vite (`vite-plugin-electron`), Web Workers (`format: "es"`), `kokoro-js` + `@huggingface/transformers` (ONNX Runtime WASM), Vitest (jsdom unit tier + Chromium browser tier).

## Context: this is Plan 1 of 4

Design spec: `docs/superpowers/specs/2026-07-01-ai-voiceover-replace-narration-design.md`.

1. **Plan 1 — TTS engine foundation** (this doc): `src/lib/tts/` provider + Kokoro worker + bundling. Deliverable: synthesize PCM from text on-device.
2. Plan 2 — Voiceover data + persistence: `VoiceoverConfig`/segmentation, `useVoiceover`, `EditorState` wiring, native-bridge `voiceover` cache, project save/migrate.
3. Plan 3 — UI + alignment: `VoiceoverPanel`, timeline row, `layoutVoiceover` pure function.
4. Plan 4 — Preview + export: Web Audio preview scheduling, `synthesizeVoiceoverTrack` export path, i18n/polish.

## Global Constraints

- **Node 22.22.1 / npm 10.9.4** (`package.json#engines`); do not change engine pins.
- **Renderer imports** (`src/`) use the `@/*` → `src/*` alias — never deep relative paths across features. Within `src/lib/tts/` use relative imports for sibling files (matches `src/lib/captioning/`).
- **Worker bundling:** `vite.config.ts` sets `worker.format: "es"` (required; the worker code-splits via dynamic import). Do not change to `iife`.
- **Production strips `console.log`/`console.debug`** (terser `drop_console`). Logging that must survive prod uses `console.warn`/`console.error`/`console.info`, always tagged `[Tts]` / `[KokoroProvider]` (per coding-style §7).
- **Security:** every `BrowserWindow` runs `contextIsolation: true`, `nodeIntegration: false` — do not weaken. The worker must never require Node builtins at runtime (that's why the Vite stubs exist).
- **CI gates:** `npm run lint` (Biome), `npx tsc --noEmit`, `npm run test`, `npx vite build`. All must stay green.
- **Kokoro model:** `onnx-community/Kokoro-82M-v1.0-ONNX`, `dtype: "q8"` (→ `onnx/model_quantized.onnx`, ≈92 MB), `device: "wasm"`, output **mono @ 24000 Hz**. English (American/British) voices only in v1.

---

### Task 1: Add `kokoro-js` dependency + Vite integration

**Files:**
- Modify: `package.json` (add `kokoro-js` dependency)
- Modify: `vite.config.ts` (aliases for `node:`-prefixed builtins + `optimizeDeps.exclude`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a build in which `import { KokoroTTS } from "kokoro-js"` resolves in both the renderer and a worker without pulling Node builtins.

**Background:** `kokoro-js` depends on `@huggingface/transformers` (v3), the successor to the repo's existing `@xenova/transformers` (v2). Both statically import Node builtins in their `env` module and reference `onnxruntime-node`. The repo already aliases bare `fs`/`path`/`url` + `onnxruntime-node` to stubs (`vite.config.ts`). v3 may import the `node:`-prefixed forms, which the bare aliases do not cover — so we add those.

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install kokoro-js
```
Expected: `kokoro-js` appears under `dependencies` in `package.json`; `@huggingface/transformers` is pulled in transitively (visible in `package-lock.json`).

- [ ] **Step 2: Extend the Vite Node-builtin stubs and optimizeDeps**

In `vite.config.ts`, replace the `resolve.alias` block's builtin aliases and the `optimizeDeps` block with the following (keep the `@` alias and the existing bare aliases; add the `node:`-prefixed ones and the new excludes):

```ts
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			// @xenova/transformers (v2) + @huggingface/transformers (v3, via kokoro-js):
			// env.js statically imports fs/path/url; onnx.js imports onnxruntime-node
			// (must not be bundled in the renderer — it requires fs). v3 uses the
			// `node:`-prefixed specifiers, so alias both forms to the empty stub.
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:fs": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:path": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:url": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"), // re-exports web ORT
		},
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers", "@huggingface/transformers", "kokoro-js"],
	},
```

- [ ] **Step 3: Verify typecheck passes**

Run:
```bash
npx tsc --noEmit
```
Expected: exits 0 (no errors). `kokoro-js` ships its own types.

- [ ] **Step 4: Verify the renderer + worker build succeeds**

Run:
```bash
npx vite build
```
Expected: build completes with no "Could not resolve 'fs'/'node:fs'/'onnxruntime-node'" errors. (A large chunk-size warning is acceptable.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vite.config.ts
git commit -m "build(tts): add kokoro-js and vite stubs for @huggingface/transformers"
```

---

### Task 2: `TtsProvider` interface + curated voice list

**Files:**
- Create: `src/lib/tts/provider.ts`
- Create: `src/lib/tts/voices.ts`
- Test: `src/lib/tts/voices.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TtsSynthesisResult { pcm: Float32Array; sampleRate: number }`
  - `TtsVoice { id: string; label: string; lang: string }`
  - `TtsSynthesizeOptions { voice: string; speed: number; onStatus?: (phase: "model" | "synthesize") => void; signal?: AbortSignal }`
  - `TtsProvider { id: string; listVoices(): Promise<TtsVoice[]>; synthesize(text: string, opts: TtsSynthesizeOptions): Promise<TtsSynthesisResult>; dispose(): void }`
  - `KOKORO_VOICES: TtsVoice[]`, `DEFAULT_KOKORO_VOICE: string`

- [ ] **Step 1: Write the provider interface**

Create `src/lib/tts/provider.ts`:
```ts
/** One synthesized clip: mono PCM plus its sample rate (Kokoro emits 24000 Hz). */
export interface TtsSynthesisResult {
	pcm: Float32Array;
	sampleRate: number;
}

/** A selectable voice. `id` matches the Kokoro voice id (e.g. "af_heart"). */
export interface TtsVoice {
	id: string;
	label: string;
	lang: string;
}

export interface TtsSynthesizeOptions {
	voice: string;
	/** Playback rate baked into synthesis. Kokoro range 0.7–1.2; 1.0 = natural. */
	speed: number;
	onStatus?: (phase: "model" | "synthesize") => void;
	signal?: AbortSignal;
}

/**
 * On-device text-to-speech engine. Implementations own their model/worker
 * lifecycle; call `dispose()` to release the worker (and the loaded model).
 */
export interface TtsProvider {
	id: string;
	listVoices(): Promise<TtsVoice[]>;
	synthesize(text: string, opts: TtsSynthesizeOptions): Promise<TtsSynthesisResult>;
	dispose(): void;
}
```

- [ ] **Step 2: Write the failing test for the voice list**

Create `src/lib/tts/voices.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES } from "./voices";

describe("KOKORO_VOICES", () => {
	it("has unique, non-empty voice ids", () => {
		const ids = KOKORO_VOICES.map((v) => v.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		for (const v of KOKORO_VOICES) {
			expect(v.id).toMatch(/^[a-z]{2}_[a-z]+$/);
			expect(v.label.length).toBeGreaterThan(0);
			expect(v.lang).toMatch(/^en-(US|GB)$/);
		}
	});

	it("includes the default voice", () => {
		expect(KOKORO_VOICES.some((v) => v.id === DEFAULT_KOKORO_VOICE)).toBe(true);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/tts/voices.test.ts
```
Expected: FAIL with a module-not-found error for `./voices`.

- [ ] **Step 4: Write the voice list**

Create `src/lib/tts/voices.ts`:
```ts
import type { TtsVoice } from "./provider";

/**
 * Curated English (American + British) Kokoro voices exposed in v1. Ids match
 * `voices/<id>.bin` in the `onnx-community/Kokoro-82M-v1.0-ONNX` repo; the full
 * set is available via `KokoroTTS.list_voices()`.
 */
export const KOKORO_VOICES: TtsVoice[] = [
	{ id: "af_heart", label: "Heart — US female", lang: "en-US" },
	{ id: "af_bella", label: "Bella — US female", lang: "en-US" },
	{ id: "af_nicole", label: "Nicole — US female", lang: "en-US" },
	{ id: "am_michael", label: "Michael — US male", lang: "en-US" },
	{ id: "am_adam", label: "Adam — US male", lang: "en-US" },
	{ id: "bf_emma", label: "Emma — UK female", lang: "en-GB" },
	{ id: "bf_isabella", label: "Isabella — UK female", lang: "en-GB" },
	{ id: "bm_george", label: "George — UK male", lang: "en-GB" },
	{ id: "bm_lewis", label: "Lewis — UK male", lang: "en-GB" },
];

export const DEFAULT_KOKORO_VOICE = "af_heart";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx vitest run src/lib/tts/voices.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tts/provider.ts src/lib/tts/voices.ts src/lib/tts/voices.test.ts
git commit -m "feat(tts): add TtsProvider interface and curated Kokoro voice list"
```

---

### Task 3: Synthesis Web Worker + typed message protocol

**Files:**
- Create: `src/lib/tts/synthesize.ts` (worker message types)
- Create: `src/lib/tts/synthesize.worker.ts`

**Interfaces:**
- Consumes: `TtsSynthesisResult` is analogous, but the worker uses its own wire types.
- Produces:
  - `SynthWorkerRequest { id: number; text: string; voice: string; speed: number; useLocalModels: boolean; assetBaseUrl?: string }`
  - `SynthWorkerResponse = { id: number; type: "status"; phase: "model" | "synthesize" } | { id: number; type: "result"; pcm: Float32Array; sampleRate: number } | { id: number; type: "error"; message: string }`

**Background:** Unlike the transcription worker (invoked once per video), TTS is invoked once **per sentence**. Reloading the ~92 MB model per call is unacceptable, so this worker loads the model **once** (cached promise) and serves many requests over its lifetime, correlated by `id`. Aborting mid-inference is not possible; the provider (Task 4) handles cancellation by dropping results and, for a hard cancel, disposing the worker.

- [ ] **Step 1: Write the worker message types**

Create `src/lib/tts/synthesize.ts`:
```ts
/** Request posted from the renderer to the TTS worker. One per synthesis call. */
export interface SynthWorkerRequest {
	/** Correlation id — the matching response carries the same id. */
	id: number;
	text: string;
	voice: string;
	speed: number;
	/**
	 * Load the Kokoro model + ORT wasm from bundled `tts-assets/` instead of the
	 * remote CDN. Required in the packaged app (runs under `file://`). The worker
	 * can't read `window.electronAPI`, so the renderer resolves this.
	 */
	useLocalModels: boolean;
	/** Base URL of bundled resources (packaged: resourcesPath file:// URL). */
	assetBaseUrl?: string;
}

/** Messages the TTS worker posts back, correlated by request `id`. */
export type SynthWorkerResponse =
	| { id: number; type: "status"; phase: "model" | "synthesize" }
	| { id: number; type: "result"; pcm: Float32Array; sampleRate: number }
	| { id: number; type: "error"; message: string };
```

- [ ] **Step 2: Write the worker**

Create `src/lib/tts/synthesize.worker.ts`:
```ts
/**
 * Web Worker running in-browser Kokoro TTS off the renderer's main thread. The
 * model is loaded once (cached) and reused across many synthesis requests, each
 * correlated by `id` — reloading the ~92 MB model per sentence would be far too
 * slow. Mirrors src/lib/captioning/transcribe.worker.ts.
 */

import type { KokoroTTS } from "kokoro-js";
import type { SynthWorkerRequest, SynthWorkerResponse } from "./synthesize";

function post(message: SynthWorkerResponse, transfer?: Transferable[]): void {
	(self as unknown as Worker).postMessage(message, transfer ?? []);
}

/**
 * ORT's wasm bundle treats a leaked `process.versions.node` (possible in an
 * Electron worker) as Node and tries `require("fs")`, which Vite can't provide.
 * Mask it only while Transformers/ORT run. No-op when `process` is undefined.
 */
function withoutNodeVersion<T>(fn: () => Promise<T>): Promise<T> {
	const versions =
		typeof process !== "undefined" && process.versions && typeof process.versions === "object"
			? process.versions
			: null;
	const hadNode = versions !== null && "node" in versions;
	const savedNode = hadNode ? (versions as { node?: string }).node : undefined;
	if (hadNode && versions) {
		try {
			Reflect.deleteProperty(versions, "node");
		} catch {
			(versions as { node?: string }).node = undefined;
		}
	}
	return fn().finally(() => {
		if (hadNode && versions && savedNode !== undefined) {
			(versions as { node: string }).node = savedNode;
		}
	});
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsPromise: Promise<KokoroTTS> | null = null;

function loadTts(opts: { useLocalModels: boolean; assetBaseUrl?: string }): Promise<KokoroTTS> {
	if (ttsPromise) return ttsPromise;
	ttsPromise = withoutNodeVersion(async () => {
		const { env } = await import("@huggingface/transformers");
		if (opts.useLocalModels && opts.assetBaseUrl) {
			// Packaged app: load bundled model + ORT wasm from disk (no network, works under file://).
			const base = new URL("tts-assets/", opts.assetBaseUrl).href;
			env.allowLocalModels = true;
			env.allowRemoteModels = false;
			env.localModelPath = new URL("models/", base).href;
			env.backends.onnx.wasm.wasmPaths = new URL("ort/", base).href;
			// Non-threaded wasm: SharedArrayBuffer isn't available under file:// (no cross-origin isolation).
			env.backends.onnx.wasm.numThreads = 1;
		} else {
			// Dev (http://localhost): fetch model + wasm from the remote CDN.
			env.allowLocalModels = false;
		}
		const { KokoroTTS } = await import("kokoro-js");
		return KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm" });
	});
	return ttsPromise;
}

self.onmessage = async (event: MessageEvent<SynthWorkerRequest>) => {
	const { id, text, voice, speed, useLocalModels, assetBaseUrl } = event.data;
	try {
		const needsLoad = ttsPromise === null;
		if (needsLoad) post({ id, type: "status", phase: "model" });
		const tts = await loadTts({ useLocalModels, assetBaseUrl });

		post({ id, type: "status", phase: "synthesize" });
		const audio = (await tts.generate(text, { voice, speed })) as {
			audio: Float32Array;
			sampling_rate: number;
		};
		// Transfer the PCM buffer (the worker no longer needs it) to avoid a copy.
		post({ id, type: "result", pcm: audio.audio, sampleRate: audio.sampling_rate }, [
			audio.audio.buffer,
		]);
	} catch (e) {
		post({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
	}
};
```

- [ ] **Step 3: Verify typecheck passes**

Run:
```bash
npx tsc --noEmit
```
Expected: exits 0. (`tts.generate(...)` is cast to the RawAudio shape `{ audio, sampling_rate }`; Task 5 verifies that shape at runtime.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/tts/synthesize.ts src/lib/tts/synthesize.worker.ts
git commit -m "feat(tts): add reusable Kokoro synthesis worker + message protocol"
```

---

### Task 4: `KokoroProvider` (long-lived worker owner)

**Files:**
- Create: `src/lib/tts/kokoroProvider.ts`
- Test: `src/lib/tts/kokoroProvider.test.ts` (unit — mocks the worker)

**Interfaces:**
- Consumes: `TtsProvider`, `TtsSynthesisResult`, `TtsVoice`, `TtsSynthesizeOptions` (Task 2); `SynthWorkerRequest`, `SynthWorkerResponse` (Task 3); `KOKORO_VOICES` (Task 2).
- Produces: `getKokoroProvider(): TtsProvider` — a lazily-created module singleton used by later plans (`useVoiceover`).

**Background:** The provider lazily creates ONE worker, correlates requests by an incrementing id, resolves/rejects the matching promise, and forwards `status` to that request's `onStatus`. `dispose()` terminates the worker and clears state (rejecting in-flight requests) so the next `synthesize` starts fresh. Because the worker is shared, a per-request `signal` abort rejects the caller's promise but lets the worker finish (result dropped) — a hard cancel is `dispose()`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tts/kokoroProvider.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake Worker that echoes a synthesized result for each posted request id.
class FakeWorker {
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	posted: unknown[] = [];
	terminated = false;
	postMessage(msg: { id: number; text: string }) {
		this.posted.push(msg);
		// Reply asynchronously, like a real worker.
		queueMicrotask(() => {
			this.onmessage?.({ data: { id: msg.id, type: "status", phase: "model" } } as MessageEvent);
			this.onmessage?.({
				data: { id: msg.id, type: "result", pcm: new Float32Array([0.1, 0.2]), sampleRate: 24000 },
			} as MessageEvent);
		});
	}
	terminate() {
		this.terminated = true;
	}
}

let fake: FakeWorker;

// The provider constructs `new Worker(new URL("./synthesize.worker.ts", import.meta.url), ...)`.
// Stub the global Worker so no real bundle/model loads in the jsdom unit tier.
beforeEach(() => {
	fake = new FakeWorker();
	vi.stubGlobal(
		"Worker",
		vi.fn(() => fake),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("getKokoroProvider", () => {
	it("synthesizes and returns the worker's PCM result", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const provider = getKokoroProvider();
		const statuses: string[] = [];
		const result = await provider.synthesize("Hello world.", {
			voice: "af_heart",
			speed: 1,
			onStatus: (p) => statuses.push(p),
		});
		expect(Array.from(result.pcm)).toEqual([
			expect.closeTo(0.1, 5),
			expect.closeTo(0.2, 5),
		]);
		expect(result.sampleRate).toBe(24000);
		expect(statuses).toContain("model");
		provider.dispose();
		expect(fake.terminated).toBe(true);
	});

	it("reuses one worker across multiple synthesize calls", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const provider = getKokoroProvider();
		await provider.synthesize("One.", { voice: "af_heart", speed: 1 });
		await provider.synthesize("Two.", { voice: "af_heart", speed: 1 });
		expect((globalThis.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
		expect(fake.posted.length).toBe(2);
		provider.dispose();
	});

	it("lists the curated voices", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const voices = await getKokoroProvider().listVoices();
		expect(voices.some((v) => v.id === "af_heart")).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/tts/kokoroProvider.test.ts
```
Expected: FAIL with a module-not-found error for `./kokoroProvider`.

- [ ] **Step 3: Write the provider**

Create `src/lib/tts/kokoroProvider.ts`:
```ts
import type { TtsProvider, TtsSynthesisResult, TtsSynthesizeOptions, TtsVoice } from "./provider";
import type { SynthWorkerRequest, SynthWorkerResponse } from "./synthesize";
import { KOKORO_VOICES } from "./voices";

interface Pending {
	resolve: (r: TtsSynthesisResult) => void;
	reject: (e: unknown) => void;
	onStatus?: (phase: "model" | "synthesize") => void;
}

/**
 * On-device Kokoro TTS provider. Owns a single long-lived worker that loads the
 * model once and serves many requests (correlated by id). `dispose()` tears the
 * worker down. Mirrors the captioning worker lifecycle, but persistent.
 */
class KokoroProvider implements TtsProvider {
	readonly id = "kokoro-local";
	private worker: Worker | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();

	async listVoices(): Promise<TtsVoice[]> {
		return KOKORO_VOICES;
	}

	synthesize(text: string, opts: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
		if (opts.signal?.aborted) {
			return Promise.reject(new DOMException("Aborted", "AbortError"));
		}
		const worker = this.ensureWorker();
		const id = this.nextId++;

		return new Promise<TtsSynthesisResult>((resolve, reject) => {
			const onAbort = () => {
				// Shared worker can't cancel in-flight inference; drop the result instead.
				if (this.pending.delete(id)) reject(new DOMException("Aborted", "AbortError"));
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			this.pending.set(id, {
				resolve: (r) => {
					opts.signal?.removeEventListener("abort", onAbort);
					resolve(r);
				},
				reject: (e) => {
					opts.signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
				onStatus: opts.onStatus,
			});

			// Packaged app runs from file:// (remote fetches fail); dev runs from http://localhost.
			const useLocalModels =
				typeof window !== "undefined" && window.location?.protocol === "file:";
			const assetBaseUrl =
				typeof window !== "undefined" ? window.electronAPI?.assetBaseUrl : undefined;

			const request: SynthWorkerRequest = {
				id,
				text,
				voice: opts.voice,
				speed: opts.speed,
				useLocalModels,
				assetBaseUrl,
			};
			worker.postMessage(request);
		});
	}

	dispose(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		for (const p of this.pending.values()) {
			p.reject(new DOMException("Disposed", "AbortError"));
		}
		this.pending.clear();
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(new URL("./synthesize.worker.ts", import.meta.url), {
			type: "module",
		});
		worker.onmessage = (e: MessageEvent<SynthWorkerResponse>) => {
			const msg = e.data;
			const p = this.pending.get(msg.id);
			if (!p) return;
			if (msg.type === "status") {
				p.onStatus?.(msg.phase);
				return;
			}
			this.pending.delete(msg.id);
			if (msg.type === "result") {
				p.resolve({ pcm: msg.pcm, sampleRate: msg.sampleRate });
			} else {
				p.reject(new Error(msg.message));
			}
		};
		worker.onerror = (e) => {
			// A worker-level error invalidates all in-flight requests.
			for (const [id, p] of this.pending) {
				this.pending.delete(id);
				p.reject(new Error(e.message || "TTS worker failed"));
			}
		};
		this.worker = worker;
		return worker;
	}
}

let singleton: KokoroProvider | null = null;

/** Lazily-created shared Kokoro provider (one worker per renderer). */
export function getKokoroProvider(): TtsProvider {
	if (!singleton) singleton = new KokoroProvider();
	return singleton;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/lib/tts/kokoroProvider.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: exits 0. (`window.electronAPI?.assetBaseUrl` is already typed in the repo — used by `transcribe.ts`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tts/kokoroProvider.ts src/lib/tts/kokoroProvider.test.ts
git commit -m "feat(tts): add KokoroProvider with reusable worker + request correlation"
```

---

### Task 5: Browser-tier end-to-end synthesis test (real model, dev/CDN)

**Files:**
- Test: `src/lib/tts/kokoroProvider.browser.test.ts`

**Interfaces:**
- Consumes: `getKokoroProvider` (Task 4).
- Produces: proof that the real `kokoro-js` + `@huggingface/transformers` stack synthesizes non-empty 24 kHz PCM under the repo's Vite/worker config. This is the de-risking gate for the whole feature.

**Background:** The browser tier runs in real Chromium (`vitest.browser.config.ts`), where WebCodecs/WASM work. This test downloads the model from the CDN on first run (~92 MB) and synthesizes a short phrase. It has a long timeout (the config already sets `testTimeout: 120_000`).

- [ ] **Step 1: Write the test**

Create `src/lib/tts/kokoroProvider.browser.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getKokoroProvider } from "./kokoroProvider";

describe("KokoroProvider (browser, real model)", () => {
	it("synthesizes non-empty 24kHz mono PCM from text", async () => {
		const provider = getKokoroProvider();
		try {
			const phases: string[] = [];
			const result = await provider.synthesize("Hello from OpenScreen.", {
				voice: "af_heart",
				speed: 1,
				onStatus: (p) => phases.push(p),
			});
			expect(result.sampleRate).toBe(24000);
			expect(result.pcm.length).toBeGreaterThan(24000 * 0.3); // > ~0.3s of audio
			// PCM must contain real signal, not silence.
			const peak = result.pcm.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
			expect(peak).toBeGreaterThan(0.01);
			expect(phases).toContain("model");
			expect(phases).toContain("synthesize");
		} finally {
			provider.dispose();
		}
	}, 120_000);
});
```

- [ ] **Step 2: Run the browser test**

Run:
```bash
npx vitest --config vitest.browser.config.ts run src/lib/tts/kokoroProvider.browser.test.ts
```
Expected: PASS. First run downloads the model (slow); subsequent runs use the browser cache. If it fails on a Node-builtin resolution error, revisit Task 1's aliases (add the exact specifier from the error).

- [ ] **Step 3: Commit**

```bash
git add src/lib/tts/kokoroProvider.browser.test.ts
git commit -m "test(tts): browser-tier end-to-end Kokoro synthesis"
```

---

### Task 6: Offline model bundling (`tts-assets/`)

**Files:**
- Create: `scripts/fetch-tts-model.mjs`
- Modify: `scripts/before-pack.cjs` (also fetch TTS assets)
- Modify: `electron-builder.json5` (`extraResources`: add `tts-assets`)
- Modify: `.gitignore` (ignore `/tts-assets/`)
- Modify: `.github/workflows/build.yml` (cache `tts-assets`, keyed on the fetch script) — apply to each of the three existing `caption-assets` cache steps.

**Interfaces:**
- Consumes: nothing at runtime; produces the on-disk `tts-assets/` layout the worker's packaged branch (Task 3) reads: `tts-assets/models/onnx-community/Kokoro-82M-v1.0-ONNX/...` and `tts-assets/ort/*.wasm`.

**Background:** Mirror the caption pipeline exactly (`scripts/fetch-caption-model.mjs` + `before-pack.cjs` + `electron-builder.json5` `extraResources` + CI cache). `dtype: "q8"` loads `onnx/model_quantized.onnx`. Voice style vectors live at `voices/<id>.bin` in the model repo; bundle the curated subset under the model dir so `@huggingface/transformers` resolves them from `localModelPath` offline.

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-tts-model.mjs`:
```js
// Populates `tts-assets/` so the packaged app can synthesize speech offline (under file://)
// instead of fetching the Kokoro model from HuggingFace and the onnxruntime wasm from a CDN.
//
//   tts-assets/
//     models/onnx-community/Kokoro-82M-v1.0-ONNX/...   ← config, tokenizer, q8 onnx, voice .bin files
//     ort/*.wasm                                       ← copied from @huggingface/transformers/dist
//
// Idempotent: existing non-empty files are left alone, so re-runs and CI cache hits are no-ops.
// `tts-assets/` is gitignored and shipped via electron-builder `extraResources`.

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tts-assets");
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

// Curated English voices exposed in v1 (must match src/lib/tts/voices.ts).
const VOICES = [
	"af_heart",
	"af_bella",
	"af_nicole",
	"am_michael",
	"am_adam",
	"bf_emma",
	"bf_isabella",
	"bm_george",
	"bm_lewis",
];

// dtype "q8" → onnx/model_quantized.onnx. Grab metadata files transformers may request.
const MODEL_FILES = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"onnx/model_quantized.onnx",
	...VOICES.map((v) => `voices/${v}.bin`),
];

async function exists(filePath) {
	try {
		const s = await stat(filePath);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, retryAfter) {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url) {
	let lastErr;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, { headers: { "user-agent": "openscreen-build" } });
			if (res.ok && res.body) return res;
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				const wait = backoffMs(attempt, res.headers.get("retry-after"));
				console.log(
					`  … HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
				);
				await sleep(wait);
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			const isHttp = err instanceof Error && err.message.startsWith("Failed to download");
			if (isHttp || attempt >= MAX_ATTEMPTS) throw err;
			const wait = backoffMs(attempt, null);
			console.log(
				`  … ${err.message}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
			);
			await sleep(wait);
		}
	}
	throw lastErr;
}

async function download(url, dest) {
	if (await exists(dest)) {
		console.log(`  ✓ cached  ${path.relative(OUT, dest)}`);
		return;
	}
	await mkdir(path.dirname(dest), { recursive: true });
	const res = await fetchWithRetry(url);
	const tmp = `${dest}.partial`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	const { rename } = await import("node:fs/promises");
	await rename(tmp, dest);
	const mb = ((await stat(dest)).size / 1_000_000).toFixed(1);
	console.log(`  ↓ ${path.relative(OUT, dest)} (${mb} MB)`);
}

async function copyOrtWasm() {
	const distDir = path.join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
	const ortOut = path.join(OUT, "ort");
	await mkdir(ortOut, { recursive: true });
	let entries;
	try {
		entries = await readdir(distDir);
	} catch {
		throw new Error(`Missing ${distDir} — is @huggingface/transformers installed? Run npm ci first.`);
	}
	const wasm = entries.filter((f) => f.endsWith(".wasm"));
	if (wasm.length === 0) throw new Error(`No .wasm files found in ${distDir}`);
	for (const name of wasm) {
		const dest = path.join(ortOut, name);
		if (await exists(dest)) {
			console.log(`  ✓ cached  ort/${name}`);
			continue;
		}
		await copyFile(path.join(distDir, name), dest);
		console.log(`  + copied ort/${name}`);
	}
}

async function main() {
	console.log(`Fetching TTS assets → ${path.relative(ROOT, OUT)}/`);
	console.log("ONNX Runtime wasm:");
	await copyOrtWasm();
	console.log(`Kokoro model (${MODEL_ID}):`);
	const modelDir = path.join(OUT, "models", ...MODEL_ID.split("/"));
	for (const rel of MODEL_FILES) {
		await download(`${HF_BASE}/${rel}`, path.join(modelDir, rel));
	}
	console.log("TTS assets ready.");
}

main().catch((err) => {
	console.error(`\nfetch-tts-model failed: ${err.message}`);
	process.exit(1);
});
```

- [ ] **Step 2: Run the fetch script (populates `tts-assets/`)**

Run:
```bash
node scripts/fetch-tts-model.mjs
```
Expected: downloads config/tokenizer/`model_quantized.onnx`/voice `.bin` files into `tts-assets/models/onnx-community/Kokoro-82M-v1.0-ONNX/` and copies `.wasm` into `tts-assets/ort/`, ending with "TTS assets ready."

- [ ] **Step 3: Wire the fetch into the electron-builder beforePack hook**

Replace the body of `exports.default` in `scripts/before-pack.cjs` so BOTH asset sets are fetched:
```js
// electron-builder beforePack hook: ensure the auto-caption (Whisper) and TTS (Kokoro) assets exist
// before packaging, so the `caption-assets` / `tts-assets` extraResources entries have something to
// copy. Runs on every package invocation. Both fetch scripts are idempotent (no-ops once present).

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function beforePack() {
	for (const script of ["fetch-caption-model.mjs", "fetch-tts-model.mjs"]) {
		execFileSync("node", [path.join(__dirname, script)], {
			stdio: "inherit",
			cwd: path.join(__dirname, ".."),
		});
	}
};
```

- [ ] **Step 4: Add `tts-assets` to electron-builder extraResources**

In `electron-builder.json5`, add a third entry to the top-level `extraResources` array (after the `caption-assets` entry):
```json5
    {
      "from": "tts-assets",
      "to": "tts-assets"
    }
```

- [ ] **Step 5: Gitignore the generated assets**

Add to `.gitignore` (next to the existing `/caption-assets/` line):
```
/tts-assets/
```

- [ ] **Step 6: Cache `tts-assets` in CI**

In `.github/workflows/build.yml`, next to EACH of the three existing `caption-assets` cache steps, add an equivalent step:
```yaml
      - uses: actions/cache@v4
        with:
          path: tts-assets
          key: tts-assets-${{ hashFiles('scripts/fetch-tts-model.mjs') }}
```

- [ ] **Step 7: Verify the fetch is idempotent**

Run:
```bash
node scripts/fetch-tts-model.mjs
```
Expected: all lines show `✓ cached` (no re-downloads).

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch-tts-model.mjs scripts/before-pack.cjs electron-builder.json5 .gitignore .github/workflows/build.yml
git commit -m "build(tts): bundle Kokoro model into tts-assets for offline synthesis"
```

**Note (manual verification, not automated):** packaged offline synthesis (`file://`) depends on `@huggingface/transformers` resolving both the model AND `voices/<id>.bin` from `localModelPath`. Confirm with a packaged build (`npm run build:mac`) on a network-disabled machine: generate a clip and verify audio. If voices fail to resolve offline (kokoro-js may fetch voice data from a hardcoded CDN in some versions), pin the kokoro-js version and adjust the voice-loading path — capture findings in Plan 2's notes.

---

## Self-Review

**Spec coverage (Plan 1 scope = spec §8.1 + §3/§4 engine decisions + §10 bundling risk):**
- On-device Kokoro behind `TtsProvider` seam → Tasks 2–4. ✅
- Worker mirrors captioning, model loaded once + reused → Task 3 (loaded-once) + Task 4 (reuse test). ✅
- `dtype: "q8"`, `device: "wasm"`, 24 kHz mono → Task 3 + Task 5 assertions. ✅
- Bundled offline assets mirroring `caption-assets` → Task 6. ✅
- `@huggingface/transformers` / Vite-stub integration risk (spec §10) → Task 1 + Task 5 (real-stack gate). ✅
- Curated English voices → Task 2. ✅
- Deferred to later plans (correctly out of Plan 1 scope): editor state, segmentation, `useVoiceover`, native-bridge cache, UI, alignment, preview, export.

**Placeholder scan:** No TBD/TODO; every code step contains full file contents or exact edits; every command has expected output. ✅

**Type consistency:** `TtsProvider`/`TtsSynthesisResult`/`TtsVoice`/`TtsSynthesizeOptions` defined in Task 2 and consumed unchanged in Task 4. Worker wire types `SynthWorkerRequest`/`SynthWorkerResponse` defined in Task 3, consumed in Tasks 3–4. RawAudio access (`.audio`, `.sampling_rate`) used in Task 3, asserted in Task 5. `getKokoroProvider()` produced in Task 4, consumed in Task 5. ✅
