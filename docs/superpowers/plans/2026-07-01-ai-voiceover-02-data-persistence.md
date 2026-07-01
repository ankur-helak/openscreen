# AI Voiceover — Plan 2: Voiceover Data Model + Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the persisted transcript into an editable, sentence-segmented voiceover script stored in undoable editor state, add a content-hash-keyed native-bridge cache for synthesized clips, and expose a `useVoiceover` orchestration hook — plus fix the packaged-offline voice-loading gap left by Plan 1.

**Architecture:** Mirror the existing transcript feature's layering. A new `src/lib/voiceover/` holds pure logic (types, content-hash key, sentence segmentation). `VoiceoverConfig` (the script) becomes an undoable `EditorState` field and is persisted in the project JSON. Synthesized PCM is cached on disk under `userData/voiceovers/<key>.pcm` via a new native-bridge `voiceover` domain (mirroring `transcript`). A `useVoiceover` hook (mirroring `useTranscript`) seeds the script from the transcript, drives explicit synthesis through the Plan 1 `KokoroProvider`, and resolves cached clips. No UI, preview, or export in this plan (Plans 3–4).

**Tech Stack:** TypeScript, React hooks, Vite (`vite-plugin-electron`), Electron native-bridge IPC (structured-clone `ipcRenderer.invoke`), `kokoro-js` + `@huggingface/transformers` (Plan 1), Vitest (jsdom unit tier + Chromium browser tier).

## Context: this is Plan 2 of 4

Design spec: `docs/superpowers/specs/2026-07-01-ai-voiceover-replace-narration-design.md`.
Plan 1 (committed): `docs/superpowers/plans/2026-07-01-ai-voiceover-01-tts-engine-foundation.md` — delivered `src/lib/tts/` (`getKokoroProvider()`, `KOKORO_VOICES`, `DEFAULT_KOKORO_VOICE`), the Kokoro worker, and offline model bundling.

1. Plan 1 — TTS engine foundation (done): synthesize PCM from text on-device.
2. **Plan 2 — Voiceover data + persistence** (this doc): offline-voices fix, `src/lib/voiceover/` (types, audioKey, segmentation), `VoiceoverConfig` in `EditorState` + project JSON, native-bridge `voiceover` cache, `useVoiceover`.
3. Plan 3 — UI + alignment: `VoiceoverPanel`, timeline row, `layoutVoiceover`, and instantiating `useVoiceover` inside `VideoEditor.tsx`.
4. Plan 4 — Preview + export: Web Audio preview scheduling, `synthesizeVoiceoverTrack` export path, i18n/polish.

## Global Constraints

- **Node 22.22.1 / npm 10.9.4** (`package.json#engines`); do not change engine pins.
- **`kokoro-js` is pinned to exactly `1.2.1`** — its voice loader behavior (Task 1) is version-specific. Do not widen to a caret.
- **Renderer imports** (`src/`) use the `@/*` → `src/*` alias — never deep relative paths across features. Within a feature folder (`src/lib/voiceover/`, `src/lib/tts/`), use relative imports for siblings.
- **`electron/` uses relative imports only** (the `@/` alias is renderer-only); it may import shared *types* from `src/` (e.g. `../../src/native/contracts`).
- **Vite alias entries are anchored RegExp** (`/^fs$/`, not `"fs"`) — a bare string `find` prefix-matches, so `"fs"` would rewrite `fs/promises` → `<stub>/promises`. Keep this invariant when editing aliases (Task 1). `resolve.alias` is the array form; `NODE_STUB`/`ORT_STUB` consts are defined at the top of each config.
- **Native bridge transport is structured-clone** (`ipcRenderer.invoke(NATIVE_BRIDGE_CHANNEL, ...)`, no JSON serialization) — `ArrayBuffer` payloads survive. New domains: shared contracts in `src/native/contracts.ts`, renderer facade in `src/native/client.ts`, transport dispatch in `electron/ipc/nativeBridge.ts`, service in `electron/native-bridge/services/*`, context dir wired in `electron/ipc/handlers.ts`. Never call raw IPC from the renderer.
- **Production strips `console.log`/`console.debug`** (terser `drop_console`). Logging that must survive prod uses `console.warn`/`console.error`/`console.info`, tagged (`[useVoiceover]`, `[VoiceoverService]`, `[tts]`).
- **Security:** every `BrowserWindow` runs `contextIsolation: true`, `nodeIntegration: false` — do not weaken. The renderer/worker must never require Node builtins at runtime.
- **CI gates (all must stay green):** `npm run lint` (Biome), `npx tsc --noEmit`, `npm run test`, `npx vite build`. Run `npm run test:browser` when touching Task 1 (worker/stub path).
- **Kokoro output:** mono Float32 PCM @ **24000 Hz** (`TtsSynthesisResult { pcm, sampleRate }`). Voice ids match `KOKORO_VOICES` in `src/lib/tts/voices.ts`; default voice `DEFAULT_KOKORO_VOICE` = `"af_heart"`.

---

### Task 1: Fix packaged-offline voice loading (deferred Plan 1 finding)

**Files:**
- Create: `src/lib/vite-stubs/kokoroVoiceFs.ts`
- Create: `src/lib/vite-stubs/kokoroVoiceFs.test.ts`
- Create: `src/lib/vite-stubs/kokoroPath.ts`
- Create: `src/lib/vite-stubs/kokoroPath.test.ts`
- Modify: `vite.config.ts` (alias `fs/promises` → voice-fs shim, `path`/`node:path` → path shim)
- Modify: `vitest.browser.config.ts` (same alias changes)
- Modify: `src/lib/tts/synthesize.worker.ts` (set/clear the voice base URL)

**Interfaces:**
- Consumes: nothing from other Plan 2 tasks. The Kokoro worker + `env.localModelPath` machinery from Plan 1.
- Produces: `setKokoroVoiceBaseUrl(url: string | null): void` (from `kokoroVoiceFs.ts`) — the worker calls this so the packaged app resolves `voices/<id>.bin` from bundled `tts-assets/` instead of the HuggingFace CDN.

**Background:** `kokoro-js@1.2.1`'s voice loader (in `node_modules/kokoro-js/dist/kokoro.js`) is, de-minified:

```js
import s from "path";
import i from "fs/promises";
// ...
async function loadVoiceData(voiceId) {
  if (i && Object.hasOwn(i, "readFile")) {                       // <-- local branch
    const dir = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
    const p = s.resolve(dir, `../voices/${voiceId}.bin`);
    const { buffer } = await i.readFile(p);
    return buffer;
  }
  const url = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voiceId}.bin`;
  try { const c = await caches.open("kokoro-voices"); const hit = await c.match(url); if (hit) return await hit.arrayBuffer(); } catch {}
  // ... falls through to fetch(url)  <-- fails offline under file://
}
```

Our current `fs/promises` alias points at the empty stub (no `readFile`), so `Object.hasOwn(i,"readFile")` is `false` and the loader always tries the CDN — which fails in a packaged, offline app under `file://`. Model + tokenizer + wasm already resolve locally (via `@huggingface/transformers` `env.localModelPath`), but voices do not, because kokoro loads them itself, bypassing `env`.

**Fix:** alias kokoro's `fs/promises` to a shim whose `readFile` (a) is present only when we set a voice base URL (so dev/CDN still works when unset) and (b) `fetch`es the bundled `voices/<id>.bin` and returns `{ buffer }`. kokoro builds the path with `path.resolve(dir, "../voices/<id>.bin")`, so we also alias `path` to a minimal shim whose `resolve` joins its args — preserving the `<id>.bin` basename our `readFile` parses. `@huggingface/transformers` also imports `path`, but it works today against the *empty* stub (it never calls `path` methods in our flow), so giving it a working `resolve`/`join`/`dirname` is harmless (unused). The existing online browser test is the regression guard.

- [ ] **Step 1: Write the failing test for the voice-fs shim**

Create `src/lib/vite-stubs/kokoroVoiceFs.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("kokoroVoiceFs shim", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exposes readFile only after a base URL is set", async () => {
		const mod = await import("./kokoroVoiceFs");
		expect(Object.hasOwn(mod.default, "readFile")).toBe(false);
		mod.setKokoroVoiceBaseUrl("https://example.test/voices/");
		expect(Object.hasOwn(mod.default, "readFile")).toBe(true);
		mod.setKokoroVoiceBaseUrl(null);
		expect(Object.hasOwn(mod.default, "readFile")).toBe(false);
	});

	it("readFile fetches <baseUrl>/<id>.bin and returns { buffer }", async () => {
		const bytes = new Float32Array([0.1, 0.2, 0.3]).buffer;
		const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
		vi.stubGlobal("fetch", fetchMock);

		const mod = await import("./kokoroVoiceFs");
		mod.setKokoroVoiceBaseUrl("https://example.test/models/Kokoro/voices/");
		// kokoro passes a path like "<dir>/../voices/af_heart.bin".
		const result = await mod.default.readFile?.("/anything/../voices/af_heart.bin");
		expect(fetchMock).toHaveBeenCalledWith("https://example.test/models/Kokoro/voices/af_heart.bin");
		expect(result?.buffer).toBe(bytes);
	});

	it("readFile rejects when the path has no voice id", async () => {
		const mod = await import("./kokoroVoiceFs");
		mod.setKokoroVoiceBaseUrl("https://example.test/voices/");
		await expect(mod.default.readFile?.("/no/extension/here")).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/vite-stubs/kokoroVoiceFs.test.ts
```
Expected: FAIL with a module-not-found error for `./kokoroVoiceFs`.

- [ ] **Step 3: Write the voice-fs shim**

Create `src/lib/vite-stubs/kokoroVoiceFs.ts`:
```ts
/**
 * Vite alias target for kokoro-js's `import i from "fs/promises"`. kokoro loads voice
 * style vectors with `if (Object.hasOwn(i, "readFile")) { ... i.readFile(path) }`,
 * otherwise it fetches them from the HuggingFace CDN — which fails in a packaged,
 * offline app under file://. We expose `readFile` ONLY while a voice base URL is set
 * (the packaged/offline branch), fetching the bundled `voices/<id>.bin`. When unset
 * (dev/CDN), `readFile` is absent so kokoro keeps its normal remote path.
 *
 * The worker sets the base URL via setKokoroVoiceBaseUrl(); because the alias and the
 * worker's own import resolve to this same module, they share `voiceBaseUrl`.
 */
interface VoiceFsShim {
	readFile?: (p: string) => Promise<{ buffer: ArrayBuffer }>;
}

let voiceBaseUrl: string | null = null;

async function readFile(p: string): Promise<{ buffer: ArrayBuffer }> {
	const id = /([^/\\]+)\.bin$/.exec(String(p))?.[1];
	if (!id) throw new Error(`[tts] cannot parse voice id from path: ${p}`);
	if (!voiceBaseUrl) throw new Error("[tts] voice base URL not set");
	const url = new URL(`${id}.bin`, voiceBaseUrl).href;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`[tts] voice fetch failed for ${id}: HTTP ${res.status}`);
	return { buffer: await res.arrayBuffer() };
}

const shim: VoiceFsShim = {};

/** Enable bundled-voice reads (packaged/offline). Pass null to restore the dev/CDN path. */
export function setKokoroVoiceBaseUrl(url: string | null): void {
	voiceBaseUrl = url;
	if (url) {
		shim.readFile = readFile;
	} else {
		shim.readFile = undefined;
		delete shim.readFile;
	}
}

export default shim;
```

- [ ] **Step 4: Run the voice-fs test to verify it passes**

Run:
```bash
npx vitest run src/lib/vite-stubs/kokoroVoiceFs.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the path shim**

Create `src/lib/vite-stubs/kokoroPath.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import pathShim from "./kokoroPath";

describe("kokoroPath shim", () => {
	it("resolve joins args and preserves the voice basename", () => {
		const out = pathShim.resolve("/some/dir", "../voices/af_heart.bin");
		expect(out.endsWith("af_heart.bin")).toBe(true);
	});

	it("resolve tolerates an undefined dir (worker has no __dirname)", () => {
		const out = pathShim.resolve(undefined as unknown as string, "../voices/bm_george.bin");
		expect(out.endsWith("bm_george.bin")).toBe(true);
	});
});
```

- [ ] **Step 6: Run the path test to verify it fails**

Run:
```bash
npx vitest run src/lib/vite-stubs/kokoroPath.test.ts
```
Expected: FAIL with a module-not-found error for `./kokoroPath`.

- [ ] **Step 7: Write the path shim**

Create `src/lib/vite-stubs/kokoroPath.ts`:
```ts
/**
 * Minimal `path` alias target. kokoro-js (`import s from "path"`) only calls
 * `s.resolve(dir, "../voices/<id>.bin")` to build a voice path; we join the parts so
 * the `<id>.bin` basename survives for kokoroVoiceFs.readFile to parse. @huggingface/
 * transformers also imports `path` but doesn't call these in our flow (it works today
 * against an empty stub), so the extra methods are harmless.
 */
function join(...parts: Array<string | undefined>): string {
	return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("/");
}

function dirname(p: string): string {
	return String(p).replace(/[/\\][^/\\]*$/, "");
}

export default { resolve: join, join, dirname };
```

- [ ] **Step 8: Run the path test to verify it passes**

Run:
```bash
npx vitest run src/lib/vite-stubs/kokoroPath.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 9: Point the Vite aliases at the new shims (both configs)**

In `vite.config.ts`, change the `fs/promises` and `path`/`node:path` alias entries (leave the anchored-RegExp form and the other entries untouched):
```ts
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "src") },
			{ find: /^fs$/, replacement: NODE_STUB },
			{ find: /^path$/, replacement: KOKORO_PATH_STUB },
			{ find: /^url$/, replacement: NODE_STUB },
			{ find: /^node:fs$/, replacement: NODE_STUB },
			{ find: /^node:path$/, replacement: KOKORO_PATH_STUB },
			{ find: /^node:url$/, replacement: NODE_STUB },
			{ find: /^fs\/promises$/, replacement: KOKORO_VOICE_FS_STUB },
			{ find: /^node:fs\/promises$/, replacement: NODE_STUB },
			{ find: /^onnxruntime-node$/, replacement: ORT_STUB }, // re-exports web ORT
		],
```
And add the two new consts next to the existing `NODE_STUB`/`ORT_STUB` at the top of `vite.config.ts`:
```ts
const KOKORO_VOICE_FS_STUB = path.resolve(__dirname, "src/lib/vite-stubs/kokoroVoiceFs.ts");
const KOKORO_PATH_STUB = path.resolve(__dirname, "src/lib/vite-stubs/kokoroPath.ts");
```
Make the identical alias + const changes in `vitest.browser.config.ts`.

- [ ] **Step 10: Wire the worker to set/clear the voice base URL**

In `src/lib/tts/synthesize.worker.ts`, add the import near the top (after the existing type imports):
```ts
import { setKokoroVoiceBaseUrl } from "@/lib/vite-stubs/kokoroVoiceFs";
```
Then, inside `loadTts`, set the base URL in the local branch and clear it in the dev branch:
```ts
		if (opts.useLocalModels && opts.assetBaseUrl) {
			// Packaged app: load bundled model + ORT wasm from disk (no network, works under file://).
			const base = new URL("tts-assets/", opts.assetBaseUrl).href;
			env.allowLocalModels = true;
			env.allowRemoteModels = false;
			env.localModelPath = new URL("models/", base).href;
			if (env.backends.onnx.wasm) {
				env.backends.onnx.wasm.wasmPaths = new URL("ort/", base).href;
				// Non-threaded wasm: SharedArrayBuffer isn't available under file:// (no cross-origin isolation).
				env.backends.onnx.wasm.numThreads = 1;
			}
			// kokoro-js loads voices itself (bypassing env.localModelPath); point its
			// fs/promises shim at the bundled voices dir so it reads them offline.
			setKokoroVoiceBaseUrl(new URL("models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/", base).href);
		} else {
			// Dev (http://localhost): fetch model + wasm + voices from the remote CDN.
			env.allowLocalModels = false;
			setKokoroVoiceBaseUrl(null);
		}
```

- [ ] **Step 11: Verify typecheck + unit tests + production build**

Run:
```bash
npx tsc --noEmit && npx vitest run src/lib/vite-stubs/ && npx vite build
```
Expected: tsc exits 0; both stub tests pass; `vite build` completes and emits `dist/assets/synthesize.worker-*.js` and `dist/assets/kokoro-*.js` with no `fs/promises` / `path` resolution errors. (A large chunk-size warning is acceptable.)

- [ ] **Step 12: Regression-check the online synthesis path (browser tier)**

Run:
```bash
npx vitest --config vitest.browser.config.ts run src/lib/tts/kokoroProvider.browser.test.ts
```
Expected: PASS — proves the dev/CDN path (voice base URL unset → kokoro's own remote loader) still synthesizes real 24 kHz PCM after the alias changes.

**Note (manual, not automated):** true offline-voice loading is only observable in a packaged build. After Plans 3–4 make voiceover reachable in the UI, verify on a network-disabled machine (`npm run build:mac`): generate a clip and confirm audio. The unit tests above prove the shim wiring; the packaged check proves the end-to-end offline path.

- [ ] **Step 13: Commit**

```bash
git add src/lib/vite-stubs/kokoroVoiceFs.ts src/lib/vite-stubs/kokoroVoiceFs.test.ts src/lib/vite-stubs/kokoroPath.ts src/lib/vite-stubs/kokoroPath.test.ts vite.config.ts vitest.browser.config.ts src/lib/tts/synthesize.worker.ts
git commit -m "fix(tts): load bundled Kokoro voices offline via fs/promises shim"
```

---

### Task 2: Voiceover types + content-hash cache key

**Files:**
- Create: `src/lib/voiceover/types.ts`
- Create: `src/lib/voiceover/audioKey.ts`
- Test: `src/lib/voiceover/audioKey.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_KOKORO_VOICE` from `@/lib/tts/voices` (Plan 1).
- Produces:
  - `VoiceoverSegment { id: string; sourceStartMs: number; sourceEndMs: number; text: string }`
  - `VoiceoverSegmentDraft = Omit<VoiceoverSegment, "id">`
  - `VoiceoverConfig { enabled: boolean; engine: "kokoro-local"; voice: string; speed: number; segments: VoiceoverSegment[] }`
  - `SegmentSynthStatus` (idle | queued | synthesizing | ready{audioKey,durationMs} | error{message})
  - `VOICEOVER_ENGINE = "kokoro-local"`, `DEFAULT_VOICEOVER_CONFIG: VoiceoverConfig`
  - `VOICEOVER_MODEL_TAG: string`, `computeAudioKey(input: { text: string; voice: string; speed: number }): string`

- [ ] **Step 1: Write the types**

Create `src/lib/voiceover/types.ts`:
```ts
import { DEFAULT_KOKORO_VOICE } from "@/lib/tts/voices";

/** Provider id for on-device Kokoro. The single value of the cloud seam in v1. */
export const VOICEOVER_ENGINE = "kokoro-local" as const;

/** One editable script line, anchored to the original spoken span. */
export interface VoiceoverSegment {
	/** "vo-<n>", allocated by the editor (see deriveNextId). */
	id: string;
	/** Anchor: original transcript segment start, in ms. */
	sourceStartMs: number;
	/** Original spoken span end, in ms (overlap/reference). */
	sourceEndMs: number;
	/** Editable script text (seeded from the transcript). */
	text: string;
}

/** A segment before an id is assigned — the output of segmentation. */
export type VoiceoverSegmentDraft = Omit<VoiceoverSegment, "id">;

/** Undoable voiceover script: project-wide voice + speed, plus the segments. */
export interface VoiceoverConfig {
	enabled: boolean;
	engine: typeof VOICEOVER_ENGINE;
	voice: string;
	/** Kokoro playback rate baked into synthesis. Range 0.7–1.2; 1.0 = natural. */
	speed: number;
	segments: VoiceoverSegment[];
}

/** Runtime (non-undoable) synthesis status for one segment. */
export type SegmentSynthStatus =
	| { state: "idle" }
	| { state: "queued" }
	| { state: "synthesizing" }
	| { state: "ready"; audioKey: string; durationMs: number }
	| { state: "error"; message: string };

/** Disabled, empty script — the default for new/legacy projects. */
export const DEFAULT_VOICEOVER_CONFIG: VoiceoverConfig = {
	enabled: false,
	engine: VOICEOVER_ENGINE,
	voice: DEFAULT_KOKORO_VOICE,
	speed: 1,
	segments: [],
};
```

- [ ] **Step 2: Write the failing test for the content-hash key**

Create `src/lib/voiceover/audioKey.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeAudioKey } from "./audioKey";

describe("computeAudioKey", () => {
	const base = { text: "Hello world.", voice: "af_heart", speed: 1 };

	it("is deterministic and hex", () => {
		const a = computeAudioKey(base);
		const b = computeAudioKey({ ...base });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]+$/);
	});

	it("changes when text, voice, or speed changes", () => {
		const key = computeAudioKey(base);
		expect(computeAudioKey({ ...base, text: "Hello world!" })).not.toBe(key);
		expect(computeAudioKey({ ...base, voice: "am_adam" })).not.toBe(key);
		expect(computeAudioKey({ ...base, speed: 1.1 })).not.toBe(key);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/voiceover/audioKey.test.ts
```
Expected: FAIL with a module-not-found error for `./audioKey`.

- [ ] **Step 4: Write the content-hash key**

Create `src/lib/voiceover/audioKey.ts`:
```ts
import { VOICEOVER_ENGINE } from "./types";

/**
 * Identifies the exact synthesis inputs. Bump/extend if the model or dtype changes so
 * old cache entries are naturally superseded (a different tag → a different key).
 */
export const VOICEOVER_MODEL_TAG = "onnx-community/Kokoro-82M-v1.0-ONNX@q8";

/**
 * cyrb53 — fast, well-distributed non-crypto string hash. Deterministic across
 * platforms. Used only as a cache key (not security), so a 64-bit hex digest is plenty
 * for the dozens–hundreds of segments in a project. Node's `crypto` isn't available in
 * the renderer bundle, hence a self-contained hash rather than sha1.
 */
function cyrb53(str: string, seed = 0): { h1: number; h2: number } {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return { h1: h1 >>> 0, h2: h2 >>> 0 };
}

/** Deterministic cache key for a synthesized clip: hash(engine + model + voice + speed + text). */
export function computeAudioKey(input: { text: string; voice: string; speed: number }): string {
	//   separators so field boundaries can't collide (e.g. voice+text vs voice_text).
	const payload = [
		VOICEOVER_ENGINE,
		VOICEOVER_MODEL_TAG,
		input.voice,
		String(input.speed),
		input.text,
	].join(" ");
	const { h1, h2 } = cyrb53(payload);
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx vitest run src/lib/voiceover/audioKey.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/voiceover/types.ts src/lib/voiceover/audioKey.ts src/lib/voiceover/audioKey.test.ts
git commit -m "feat(voiceover): add voiceover types + content-hash cache key"
```

---

### Task 3: Sentence segmentation

**Files:**
- Create: `src/lib/voiceover/segmentation.ts`
- Test: `src/lib/voiceover/segmentation.test.ts`

**Interfaces:**
- Consumes: `CaptionSegment` from `@/lib/captioning` (`{ startSec: number; endSec: number; text: string }`); `VoiceoverSegmentDraft` (Task 2).
- Produces: `segmentTranscript(segments: CaptionSegment[], opts?: SegmentationOptions): VoiceoverSegmentDraft[]`; `SegmentationOptions { silenceGapMs?: number; maxClipMs?: number }`; `DEFAULT_SEGMENTATION: Required<SegmentationOptions>`.

**Background:** The persisted transcript is `CaptionSegment[]` (word/phrase units with `startSec`/`endSec`). Group them into sentence-sized clips. A new unit starts when: the accumulated text already ended a sentence (`.`/`!`/`?`), OR the inter-segment silence gap exceeds the threshold, OR appending would exceed the max clip length. Anchor each unit at its first constituent's start and its last constituent's end. Returns id-less drafts; the caller assigns `vo-<n>` ids (Task 6 / Plan 3).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/voiceover/segmentation.test.ts`:
```ts
import type { CaptionSegment } from "@/lib/captioning";
import { describe, expect, it } from "vitest";
import { segmentTranscript } from "./segmentation";

const seg = (startSec: number, endSec: number, text: string): CaptionSegment => ({
	startSec,
	endSec,
	text,
});

describe("segmentTranscript", () => {
	it("returns [] for no segments", () => {
		expect(segmentTranscript([])).toEqual([]);
	});

	it("splits on sentence-ending punctuation", () => {
		const out = segmentTranscript([
			seg(0, 0.5, "Hello"),
			seg(0.5, 1, "world."),
			seg(1, 1.5, "Next"),
			seg(1.5, 2, "one."),
		]);
		expect(out).toHaveLength(2);
		expect(out[0].text).toBe("Hello world.");
		expect(out[0].sourceStartMs).toBe(0);
		expect(out[0].sourceEndMs).toBe(1000);
		expect(out[1].text).toBe("Next one.");
		expect(out[1].sourceStartMs).toBe(1000);
	});

	it("splits on a long silence gap even without punctuation", () => {
		const out = segmentTranscript(
			[seg(0, 0.5, "part one"), seg(3, 3.5, "part two")],
			{ silenceGapMs: 700 },
		);
		expect(out).toHaveLength(2);
		expect(out[0].text).toBe("part one");
		expect(out[1].text).toBe("part two");
	});

	it("caps a run of unpunctuated segments at maxClipMs", () => {
		const segs: CaptionSegment[] = [];
		for (let i = 0; i < 10; i++) segs.push(seg(i, i + 1, `w${i}`));
		const out = segmentTranscript(segs, { maxClipMs: 3000, silenceGapMs: 5000 });
		for (const clip of out) {
			expect(clip.sourceEndMs - clip.sourceStartMs).toBeLessThanOrEqual(3000);
		}
		expect(out.length).toBeGreaterThan(1);
	});

	it("skips blank segments and trims text", () => {
		const out = segmentTranscript([seg(0, 0.5, "  Hi.  "), seg(0.5, 1, "   ")]);
		expect(out).toHaveLength(1);
		expect(out[0].text).toBe("Hi.");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/lib/voiceover/segmentation.test.ts
```
Expected: FAIL with a module-not-found error for `./segmentation`.

- [ ] **Step 3: Write the segmentation function**

Create `src/lib/voiceover/segmentation.ts`:
```ts
import type { CaptionSegment } from "@/lib/captioning";
import type { VoiceoverSegmentDraft } from "./types";

export interface SegmentationOptions {
	/** Start a new clip when the silence between segments exceeds this (ms). */
	silenceGapMs?: number;
	/** Never let a clip's spanned source duration exceed this (ms). */
	maxClipMs?: number;
}

export const DEFAULT_SEGMENTATION: Required<SegmentationOptions> = {
	silenceGapMs: 700,
	maxClipMs: 24_000,
};

function endsSentence(text: string): boolean {
	return /[.!?]["')\]]?\s*$/.test(text);
}

interface Accum {
	startMs: number;
	endMs: number;
	parts: string[];
}

/**
 * Groups transcript segments into sentence-sized voiceover clips. A new clip begins
 * when the current text already ended a sentence, when the inter-segment silence gap
 * exceeds `silenceGapMs`, or when appending would push the spanned duration past
 * `maxClipMs`. Blank segments are dropped; text is trimmed and single-space joined.
 */
export function segmentTranscript(
	segments: CaptionSegment[],
	opts: SegmentationOptions = {},
): VoiceoverSegmentDraft[] {
	const { silenceGapMs, maxClipMs } = { ...DEFAULT_SEGMENTATION, ...opts };
	const out: VoiceoverSegmentDraft[] = [];
	let cur: Accum | null = null;
	let prevEndMs = 0;

	const flush = () => {
		if (!cur) return;
		const text = cur.parts.join(" ").trim();
		if (text) out.push({ sourceStartMs: cur.startMs, sourceEndMs: cur.endMs, text });
		cur = null;
	};

	for (const s of segments) {
		const text = s.text.trim();
		if (!text) continue;
		const startMs = Math.round(s.startSec * 1000);
		const endMs = Math.round(s.endSec * 1000);

		if (cur) {
			const gap = startMs - prevEndMs;
			const wouldExceed = endMs - cur.startMs > maxClipMs;
			if (endsSentence(cur.parts[cur.parts.length - 1]) || gap > silenceGapMs || wouldExceed) {
				flush();
			}
		}

		if (!cur) {
			cur = { startMs, endMs, parts: [text] };
		} else {
			cur.parts.push(text);
			cur.endMs = endMs;
		}
		prevEndMs = endMs;
	}
	flush();
	return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/lib/voiceover/segmentation.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/voiceover/segmentation.ts src/lib/voiceover/segmentation.test.ts
git commit -m "feat(voiceover): add sentence segmentation from transcript"
```

---

### Task 4: EditorState field + project persistence (version 3)

**Files:**
- Modify: `src/hooks/useEditorHistory.ts` (add `voiceover` to `EditorState` + `INITIAL_EDITOR_STATE`)
- Modify: `src/components/video-editor/projectPersistence.ts:65,67-95,220-534` (bump `PROJECT_VERSION`; add `voiceover` to `ProjectEditorState`; normalize it)
- Modify: `src/components/video-editor/VideoEditor.tsx:187-209,412-434,489-546,675-703` (thread `voiceover` through the load + save snapshots)
- Test: `src/components/video-editor/projectPersistence.test.ts` (add voiceover cases)

**Interfaces:**
- Consumes: `VoiceoverConfig`, `DEFAULT_VOICEOVER_CONFIG`, `VOICEOVER_ENGINE` (Task 2); `DEFAULT_KOKORO_VOICE` (Plan 1).
- Produces: `EditorState.voiceover: VoiceoverConfig`; `ProjectEditorState.voiceover: VoiceoverConfig`; `PROJECT_VERSION = 3`; a `normalizeProjectEditor` that defaults `voiceover` for legacy (v1/v2) projects.

**Background:** `normalizeProjectEditor` is the de-facto migration — it defaults every field per-field, so a v2 project simply gets a default `voiceover`. `validateProjectData` only checks `version` is a number, so bumping to 3 is a marker; no version switch is needed. The snapshot builders in `VideoEditor.tsx` list fields explicitly (no spread), and `createProjectData` requires the full `ProjectEditorState`, so `voiceover` must be added at each site.

- [ ] **Step 1: Write the failing persistence tests**

Add to `src/components/video-editor/projectPersistence.test.ts` (append inside the existing top-level `describe`, or add a new one):
```ts
import { DEFAULT_VOICEOVER_CONFIG } from "@/lib/voiceover/types";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "./projectPersistence";

describe("voiceover persistence", () => {
	it("PROJECT_VERSION is 3", () => {
		expect(PROJECT_VERSION).toBe(3);
	});

	it("defaults voiceover to disabled/empty for legacy projects", () => {
		const normalized = normalizeProjectEditor({});
		expect(normalized.voiceover).toEqual(DEFAULT_VOICEOVER_CONFIG);
	});

	it("round-trips a voiceover config, clamping speed and dropping bad segments", () => {
		const normalized = normalizeProjectEditor({
			voiceover: {
				enabled: true,
				engine: "kokoro-local",
				voice: "am_adam",
				speed: 5, // out of range → clamped to 1.2
				segments: [
					{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 1000, text: "Hi." },
					{ id: 123, text: "bad id" }, // dropped
				],
			},
		} as never);
		expect(normalized.voiceover.enabled).toBe(true);
		expect(normalized.voiceover.voice).toBe("am_adam");
		expect(normalized.voiceover.speed).toBe(1.2);
		expect(normalized.voiceover.segments).toEqual([
			{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 1000, text: "Hi." },
		]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/components/video-editor/projectPersistence.test.ts
```
Expected: FAIL — `PROJECT_VERSION` is 2 and `normalized.voiceover` is undefined.

- [ ] **Step 3: Add `voiceover` to `EditorState` + `INITIAL_EDITOR_STATE`**

In `src/hooks/useEditorHistory.ts`, add the import (with the other `@/components/video-editor` imports):
```ts
import type { VoiceoverConfig } from "@/lib/voiceover/types";
import { DEFAULT_VOICEOVER_CONFIG } from "@/lib/voiceover/types";
```
Add the field to the `EditorState` interface (after `webcamPosition`):
```ts
	webcamPosition: WebcamPosition | null;
	/** AI voiceover script (project-wide voice + speed + editable segments). */
	voiceover: VoiceoverConfig;
```
Add it to `INITIAL_EDITOR_STATE` (after `webcamPosition`):
```ts
	webcamPosition: DEFAULT_WEBCAM_SETTINGS.position,
	voiceover: DEFAULT_VOICEOVER_CONFIG,
```

- [ ] **Step 4: Bump the version and add `voiceover` to `ProjectEditorState` + normalization**

In `src/components/video-editor/projectPersistence.ts`:

Add imports (with the other `@/lib` imports at the top):
```ts
import { DEFAULT_VOICEOVER_CONFIG, VOICEOVER_ENGINE } from "@/lib/voiceover/types";
import type { VoiceoverConfig, VoiceoverSegment } from "@/lib/voiceover/types";
```
Bump the version:
```ts
export const PROJECT_VERSION = 3;
```
Add the field to `ProjectEditorState` (after `cursorTheme`):
```ts
	cursorTheme: string;
	voiceover: VoiceoverConfig;
```
Add a normalizer helper above `normalizeProjectEditor`:
```ts
function normalizeVoiceoverConfig(raw: unknown): VoiceoverConfig {
	const v = (raw && typeof raw === "object" ? raw : {}) as Partial<VoiceoverConfig>;
	const segments: VoiceoverSegment[] = Array.isArray(v.segments)
		? v.segments
				.filter(
					(s): s is VoiceoverSegment =>
						Boolean(s && typeof s.id === "string" && typeof s.text === "string"),
				)
				.map((s) => ({
					id: s.id,
					text: s.text,
					sourceStartMs: isFiniteNumber(s.sourceStartMs) ? Math.max(0, Math.round(s.sourceStartMs)) : 0,
					sourceEndMs: isFiniteNumber(s.sourceEndMs) ? Math.max(0, Math.round(s.sourceEndMs)) : 0,
				}))
		: [];
	return {
		enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_VOICEOVER_CONFIG.enabled,
		engine: VOICEOVER_ENGINE,
		voice: typeof v.voice === "string" && v.voice ? v.voice : DEFAULT_VOICEOVER_CONFIG.voice,
		speed: isFiniteNumber(v.speed) ? clamp(v.speed, 0.7, 1.2) : DEFAULT_VOICEOVER_CONFIG.speed,
		segments,
	};
}
```
Add `voiceover` to the `normalizeProjectEditor` return object (after `gifSizePreset`):
```ts
		voiceover: normalizeVoiceoverConfig(editor.voiceover),
```

- [ ] **Step 5: Thread `voiceover` through VideoEditor's load + save snapshots**

In `src/components/video-editor/VideoEditor.tsx`:

Add `voiceover` to the editor-state destructure (after `webcamPosition`, ~line 208):
```ts
		webcamPosition,
		voiceover,
	} = editorState;
```
Add `voiceover` to the load `pushState({...})` (after `webcamPosition`, ~line 433):
```ts
				webcamPosition: normalizedEditor.webcamPosition,
				voiceover: normalizedEditor.voiceover,
			});
```
Add `voiceover` to the `currentProjectSnapshot` `createProjectSnapshot({...})` object (after `cursorTheme`, ~line 516) AND to its dependency array (after `cursorTheme`, ~line 546):
```ts
				cursorTheme,
				voiceover,
			});
```
```ts
			cursorTheme,
			voiceover,
```
Add `voiceover` to the save `editorState` literal (after `cursorTheme`, ~line 702):
```ts
				cursorTheme,
				voiceover,
			};
```

- [ ] **Step 6: Run the persistence tests + typecheck**

Run:
```bash
npx vitest run src/components/video-editor/projectPersistence.test.ts && npx tsc --noEmit
```
Expected: persistence tests PASS; tsc exits 0 (the new required `voiceover` field on `ProjectEditorState` is satisfied at every `createProjectData`/`createProjectSnapshot` site).

- [ ] **Step 7: Full unit suite + lint (this task touches shared editor state)**

Run:
```bash
npx vitest run && npm run lint
```
Expected: all unit tests pass; lint exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useEditorHistory.ts src/components/video-editor/projectPersistence.ts src/components/video-editor/projectPersistence.test.ts src/components/video-editor/VideoEditor.tsx
git commit -m "feat(voiceover): persist VoiceoverConfig in editor state + project v3"
```

---

### Task 5: Native-bridge `voiceover` clip cache

**Files:**
- Modify: `src/native/contracts.ts` (add `VoiceoverClipResult` + `voiceover` request union members)
- Create: `electron/native-bridge/services/voiceoverService.ts`
- Test: `electron/native-bridge/services/voiceoverService.test.ts`
- Modify: `electron/ipc/nativeBridge.ts` (import, `NativeBridgeContext.getVoiceoverCacheDir`, instantiate, dispatch)
- Modify: `electron/ipc/handlers.ts:2915-2916` (provide `getVoiceoverCacheDir`)
- Modify: `src/native/client.ts` (add `voiceover` facade + import result type)

**Interfaces:**
- Consumes: nothing from other Plan 2 tasks (audio is opaque bytes). Mirrors `TranscriptService`.
- Produces:
  - Contract `VoiceoverClipResult { success: boolean; pcm?: ArrayBuffer; sampleRate?: number; message?: string }`
  - Request actions `getVoiceoverClip { key }`, `putVoiceoverClip { key, pcm, sampleRate }`
  - `nativeBridgeClient.voiceover.getClip(key): Promise<VoiceoverClipResult>`
  - `nativeBridgeClient.voiceover.putClip(key, pcm: ArrayBuffer, sampleRate: number): Promise<VoiceoverClipResult>`
  - `VoiceoverService` (main process), keyed by the **content hash** (not the source video), storing mono Float32 PCM + sample rate.

**Background:** Unlike transcripts (keyed by a video stat signature), voiceover clips are defined by *what generates them* (text + voice + speed + model), so they're keyed by the `audioKey` content hash (Task 2). The transport is structured-clone, so PCM travels as an `ArrayBuffer`. On disk each clip is a small self-describing binary: `[uint32 LE sampleRate][uint32 LE sampleCount][float32 data]`.

- [ ] **Step 1: Write the failing service test**

Create `electron/native-bridge/services/voiceoverService.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceoverService } from "./voiceoverService";

let root: string;
let service: VoiceoverService;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "vo-cache-"));
	service = new VoiceoverService({ cacheDir: path.join(root, "voiceovers") });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("VoiceoverService", () => {
	it("round-trips PCM + sample rate", async () => {
		const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const put = await service.putClip("abc123", pcm.buffer, 24000);
		expect(put.success).toBe(true);

		const got = await service.getClip("abc123");
		expect(got.success).toBe(true);
		expect(got.sampleRate).toBe(24000);
		expect(got.pcm).toBeInstanceOf(ArrayBuffer);
		expect(Array.from(new Float32Array(got.pcm as ArrayBuffer))).toEqual(Array.from(pcm));
	});

	it("returns success with no pcm on a cache miss", async () => {
		const got = await service.getClip("missing");
		expect(got.success).toBe(true);
		expect(got.pcm).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run electron/native-bridge/services/voiceoverService.test.ts
```
Expected: FAIL with a module-not-found error for `./voiceoverService`.

- [ ] **Step 3: Write the service**

Create `electron/native-bridge/services/voiceoverService.ts`:
```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VoiceoverClipResult } from "../../../src/native/contracts";

interface VoiceoverServiceOptions {
	/** Directory for cached clips (e.g. userData/voiceovers). */
	cacheDir: string;
}

/**
 * File-backed cache for synthesized voiceover clips, keyed by the renderer's content
 * hash (text + voice + speed + model). Each `<key>.pcm` file is self-describing:
 * [uint32 LE sampleRate][uint32 LE sampleCount][float32 PCM]. Unlike the transcript
 * cache, the key is the audio's identity, so it's stable across source videos/machines.
 */
export class VoiceoverService {
	constructor(private readonly options: VoiceoverServiceOptions) {}

	private fileFor(key: string): string {
		// Keys are hex digests, but sanitize defensively so a key can never escape the dir.
		return path.join(this.options.cacheDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.pcm`);
	}

	async getClip(key: string): Promise<VoiceoverClipResult> {
		try {
			const buf = await readFile(this.fileFor(key));
			const sampleRate = buf.readUInt32LE(0);
			const count = buf.readUInt32LE(4);
			const start = buf.byteOffset + 8;
			const pcm = buf.buffer.slice(start, start + count * 4);
			return { success: true, pcm, sampleRate };
		} catch {
			// Missing/unreadable → cache miss (mirrors TranscriptService.readJson).
			return { success: true };
		}
	}

	async putClip(key: string, pcm: ArrayBuffer, sampleRate: number): Promise<VoiceoverClipResult> {
		try {
			await mkdir(this.options.cacheDir, { recursive: true });
			const floats = new Float32Array(pcm);
			const header = Buffer.alloc(8);
			header.writeUInt32LE(sampleRate, 0);
			header.writeUInt32LE(floats.length, 4);
			await writeFile(this.fileFor(key), Buffer.concat([header, Buffer.from(pcm)]));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
```

- [ ] **Step 4: Run the service test to verify it passes**

Run:
```bash
npx vitest run electron/native-bridge/services/voiceoverService.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add the contracts**

In `src/native/contracts.ts`, add the result type next to `TranscriptCacheResult` (~line 105):
```ts
export interface VoiceoverClipResult {
	success: boolean;
	/** Mono Float32 PCM as an ArrayBuffer when present; absent on a cache miss. */
	pcm?: ArrayBuffer;
	/** Sample rate of the cached PCM (Kokoro: 24000). */
	sampleRate?: number;
	message?: string;
}
```
Add the two request union members next to the transcript ones (~after line 250):
```ts
	| {
			domain: "voiceover";
			action: "getVoiceoverClip";
			payload: { key: string };
			requestId?: string;
	  }
	| {
			domain: "voiceover";
			action: "putVoiceoverClip";
			payload: { key: string; pcm: ArrayBuffer; sampleRate: number };
			requestId?: string;
	  }
```

- [ ] **Step 6: Add the context accessor + wire the service + dispatch**

In `electron/ipc/nativeBridge.ts`:

Import the service (with the other service imports, ~line 17):
```ts
import { VoiceoverService } from "../native-bridge/services/voiceoverService";
```
Add to the `NativeBridgeContext` interface (after `getCaptionDraftsDir`, ~line 42):
```ts
	getCaptionDraftsDir: () => string;
	getVoiceoverCacheDir: () => string;
```
Instantiate it next to `transcriptService` (~line 124):
```ts
	const voiceoverService = new VoiceoverService({
		cacheDir: context.getVoiceoverCacheDir(),
	});
```
Add a `voiceover` case in the domain switch, after the `transcript` case (~line 272):
```ts
				case "voiceover": {
					const action = request.action as string;
					switch (request.action) {
						case "getVoiceoverClip":
							return createSuccessResponse(
								requestId,
								await voiceoverService.getClip(request.payload.key),
							);
						case "putVoiceoverClip":
							return createSuccessResponse(
								requestId,
								await voiceoverService.putClip(
									request.payload.key,
									request.payload.pcm,
									request.payload.sampleRate,
								),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported voiceover action: ${action}`,
							);
					}
				}
```

- [ ] **Step 7: Provide the cache dir in the handlers wiring**

In `electron/ipc/handlers.ts`, add to the `registerNativeBridgeHandlers({...})` context object (after `getCaptionDraftsDir`, ~line 2916):
```ts
		getCaptionDraftsDir: () => path.join(app.getPath("userData"), "caption-drafts"),
		getVoiceoverCacheDir: () => path.join(app.getPath("userData"), "voiceovers"),
```

- [ ] **Step 8: Add the renderer client facade**

In `src/native/client.ts`, add `VoiceoverClipResult` to the type import from `./contracts` (keep alphabetical/existing order):
```ts
	type TranscriptCacheResult,
	type VoiceoverClipResult,
```
Add the `voiceover` facade to `nativeBridgeClient` (after the `transcript` block, ~line 154):
```ts
	voiceover: {
		getClip: (key: string) =>
			requireNativeBridgeData<VoiceoverClipResult>({
				domain: "voiceover",
				action: "getVoiceoverClip",
				payload: { key },
			}),
		putClip: (key: string, pcm: ArrayBuffer, sampleRate: number) =>
			requireNativeBridgeData<VoiceoverClipResult>({
				domain: "voiceover",
				action: "putVoiceoverClip",
				payload: { key, pcm, sampleRate },
			}),
	},
```

- [ ] **Step 9: Typecheck + build (verify main + renderer + contracts agree)**

Run:
```bash
npx tsc --noEmit && npx vite build
```
Expected: exits 0; build succeeds (main bundle includes the new dispatch case, renderer includes the facade).

- [ ] **Step 10: Commit**

```bash
git add src/native/contracts.ts src/native/client.ts electron/ipc/nativeBridge.ts electron/ipc/handlers.ts electron/native-bridge/services/voiceoverService.ts electron/native-bridge/services/voiceoverService.test.ts
git commit -m "feat(voiceover): add native-bridge voiceover clip cache"
```

---

### Task 6: `useVoiceover` orchestration hook

**Files:**
- Create: `src/hooks/useVoiceover.ts`
- Test: `src/hooks/useVoiceover.test.ts`

**Interfaces:**
- Consumes: `VoiceoverConfig`, `VoiceoverSegment`, `SegmentSynthStatus` (Task 2); `computeAudioKey` (Task 2); `segmentTranscript` (Task 3); `Transcript` (`@/lib/transcription`); `getKokoroProvider` + `TtsProvider` (Plan 1); `nativeBridgeClient.voiceover` (Task 5).
- Produces:
  - `UseVoiceoverResult { statuses: Record<string, SegmentSynthStatus>; clips: Record<string, ResolvedClip>; audioKeyFor: (segment: VoiceoverSegment) => string; seedFromTranscript: () => void; generateSegment: (id: string) => Promise<void>; generateAll: () => Promise<void> }`
  - `ResolvedClip { pcm: Float32Array; sampleRate: number; durationMs: number }`
  - `useVoiceover(params: { config: VoiceoverConfig; transcript: Transcript | null; onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void; provider?: TtsProvider }): UseVoiceoverResult`

**Background:** Mirrors `useTranscript`, but the *script* is undoable `EditorState` (passed in as `config`, mutated via `onChange`), while per-segment *synthesis status* is runtime (owned here). `audioKeyFor` derives the content hash from a segment's text and the project-wide voice/speed. On config change, an effect resolves each segment against the cache (hit → `ready`; miss → `idle`). `generateSegment` synthesizes via the shared Kokoro worker (Plan 1), writes the clip to the cache (Task 5), and marks `ready`. `generateAll` runs sequentially (one worker). `seedFromTranscript` populates `config.segments` from the transcript when empty, assigning `vo-<n>` ids. Plan 3 instantiates this hook in `VideoEditor.tsx` and builds the UI.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/useVoiceover.test.ts`:
```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsProvider } from "@/lib/tts/provider";
import type { Transcript } from "@/lib/transcription";
import { computeAudioKey } from "@/lib/voiceover/audioKey";
import { DEFAULT_VOICEOVER_CONFIG, type VoiceoverConfig } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";
import { useVoiceover } from "./useVoiceover";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		voiceover: {
			getClip: vi.fn(async () => ({ success: true })),
			putClip: vi.fn(async () => ({ success: true })),
		},
	},
}));

const fakeProvider = (): TtsProvider => ({
	id: "kokoro-local",
	listVoices: async () => [],
	synthesize: async () => ({ pcm: new Float32Array(24000), sampleRate: 24000 }),
	dispose: () => {},
});

const transcript: Transcript = {
	segments: [
		{ startSec: 0, endSec: 1, text: "Hello world." },
		{ startSec: 1, endSec: 2, text: "Second line." },
	],
	granularity: "phrase",
	provider: "whisper",
	model: "tiny",
	audioDurationSec: 2,
	truncated: false,
	createdAt: 0,
	schemaVersion: 1,
};

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("useVoiceover", () => {
	it("seedFromTranscript populates empty segments with vo- ids", () => {
		let config: VoiceoverConfig = { ...DEFAULT_VOICEOVER_CONFIG };
		const onChange = vi.fn((updater: (p: VoiceoverConfig) => VoiceoverConfig) => {
			config = updater(config);
		});
		const { result, rerender } = renderHook(
			(props: { config: VoiceoverConfig }) =>
				useVoiceover({ config: props.config, transcript, onChange, provider: fakeProvider() }),
			{ initialProps: { config } },
		);
		act(() => result.current.seedFromTranscript());
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(config.segments).toHaveLength(2);
		expect(config.segments[0].id).toBe("vo-1");
		expect(config.segments[0].text).toBe("Hello world.");
		rerender({ config });
	});

	it("generateSegment synthesizes, caches, and marks ready", async () => {
		const config: VoiceoverConfig = {
			...DEFAULT_VOICEOVER_CONFIG,
			segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 1000, text: "Hello world." }],
		};
		const { result } = renderHook(() =>
			useVoiceover({ config, transcript, onChange: vi.fn(), provider: fakeProvider() }),
		);
		await act(async () => {
			await result.current.generateSegment("vo-1");
		});
		const key = computeAudioKey({ text: "Hello world.", voice: config.voice, speed: config.speed });
		expect(nativeBridgeClient.voiceover.putClip).toHaveBeenCalledWith(
			key,
			expect.any(ArrayBuffer),
			24000,
		);
		expect(result.current.statuses["vo-1"]).toEqual({
			state: "ready",
			audioKey: key,
			durationMs: 1000,
		});
		expect(result.current.clips[key].durationMs).toBe(1000);
	});

	it("resolves a cache hit to ready without synthesizing", async () => {
		const pcm = new Float32Array(12000); // 0.5s @ 24kHz
		(nativeBridgeClient.voiceover.getClip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			success: true,
			pcm: pcm.buffer,
			sampleRate: 24000,
		});
		const config: VoiceoverConfig = {
			...DEFAULT_VOICEOVER_CONFIG,
			segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "Cached." }],
		};
		const provider = fakeProvider();
		const synthSpy = vi.spyOn(provider, "synthesize");
		const { result } = renderHook(() =>
			useVoiceover({ config, transcript, onChange: vi.fn(), provider }),
		);
		await waitFor(() => {
			expect(result.current.statuses["vo-1"]?.state).toBe("ready");
		});
		expect(synthSpy).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/hooks/useVoiceover.test.ts
```
Expected: FAIL with a module-not-found error for `./useVoiceover`.

- [ ] **Step 3: Write the hook**

Create `src/hooks/useVoiceover.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { getKokoroProvider } from "@/lib/tts/kokoroProvider";
import type { TtsProvider } from "@/lib/tts/provider";
import type { Transcript } from "@/lib/transcription";
import { computeAudioKey } from "@/lib/voiceover/audioKey";
import { segmentTranscript } from "@/lib/voiceover/segmentation";
import type { SegmentSynthStatus, VoiceoverConfig, VoiceoverSegment } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";

export interface ResolvedClip {
	pcm: Float32Array;
	sampleRate: number;
	durationMs: number;
}

export interface UseVoiceoverResult {
	statuses: Record<string, SegmentSynthStatus>;
	clips: Record<string, ResolvedClip>;
	audioKeyFor: (segment: VoiceoverSegment) => string;
	seedFromTranscript: () => void;
	generateSegment: (id: string) => Promise<void>;
	generateAll: () => Promise<void>;
}

function durationMsOf(pcmLength: number, sampleRate: number): number {
	return Math.round((pcmLength / sampleRate) * 1000);
}

/**
 * Orchestrates voiceover synthesis for the current script. The script itself is undoable
 * editor state (`config`, mutated via `onChange`); per-segment synthesis status and
 * resolved audio are runtime-only and owned here. Mirrors useTranscript, but per-segment.
 */
export function useVoiceover(params: {
	config: VoiceoverConfig;
	transcript: Transcript | null;
	onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void;
	provider?: TtsProvider;
}): UseVoiceoverResult {
	const { config, transcript, onChange } = params;
	const provider = params.provider ?? getKokoroProvider();

	const [statuses, setStatuses] = useState<Record<string, SegmentSynthStatus>>({});
	const [clips, setClips] = useState<Record<string, ResolvedClip>>({});

	// Latest values without making callbacks depend on their identity.
	const configRef = useRef(config);
	configRef.current = config;
	const providerRef = useRef(provider);
	providerRef.current = provider;

	const audioKeyFor = useCallback(
		(segment: VoiceoverSegment) =>
			computeAudioKey({
				text: segment.text,
				voice: configRef.current.voice,
				speed: configRef.current.speed,
			}),
		[],
	);

	const seedFromTranscript = useCallback(() => {
		const cfg = configRef.current;
		if (cfg.segments.length > 0) return;
		const source = transcript?.segments ?? [];
		if (source.length === 0) return;
		const drafts = segmentTranscript(source);
		if (drafts.length === 0) return;
		const segments: VoiceoverSegment[] = drafts.map((d, i) => ({ id: `vo-${i + 1}`, ...d }));
		onChange((prev) => (prev.segments.length > 0 ? prev : { ...prev, segments }));
	}, [transcript, onChange]);

	const generateSegment = useCallback(async (id: string) => {
		const segment = configRef.current.segments.find((s) => s.id === id);
		if (!segment) return;
		const key = computeAudioKey({
			text: segment.text,
			voice: configRef.current.voice,
			speed: configRef.current.speed,
		});
		setStatuses((prev) => ({ ...prev, [id]: { state: "synthesizing" } }));
		try {
			const { pcm, sampleRate } = await providerRef.current.synthesize(segment.text, {
				voice: configRef.current.voice,
				speed: configRef.current.speed,
			});
			const durationMs = durationMsOf(pcm.length, sampleRate);
			await nativeBridgeClient.voiceover.putClip(key, pcm.buffer as ArrayBuffer, sampleRate);
			setClips((prev) => ({ ...prev, [key]: { pcm, sampleRate, durationMs } }));
			setStatuses((prev) => ({ ...prev, [id]: { state: "ready", audioKey: key, durationMs } }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[useVoiceover] synthesis failed:", message);
			setStatuses((prev) => ({ ...prev, [id]: { state: "error", message } }));
		}
	}, []);

	const generateAll = useCallback(async () => {
		for (const segment of configRef.current.segments) {
			if (statuses[segment.id]?.state === "ready") continue;
			await generateSegment(segment.id);
		}
	}, [generateSegment, statuses]);

	// Resolve each segment against the cache when the script/voice/speed changes.
	// Cache hit → ready (+ decoded clip); miss → idle (awaiting explicit generation).
	useEffect(() => {
		let cancelled = false;
		(async () => {
			for (const segment of config.segments) {
				const key = computeAudioKey({ text: segment.text, voice: config.voice, speed: config.speed });
				const current = statuses[segment.id];
				if (current?.state === "ready" && current.audioKey === key) continue;
				if (current?.state === "synthesizing" || current?.state === "queued") continue;
				const hit = await nativeBridgeClient.voiceover.getClip(key);
				if (cancelled) return;
				if (hit.success && hit.pcm && typeof hit.sampleRate === "number") {
					const pcm = new Float32Array(hit.pcm);
					const durationMs = durationMsOf(pcm.length, hit.sampleRate);
					setClips((prev) => ({ ...prev, [key]: { pcm, sampleRate: hit.sampleRate as number, durationMs } }));
					setStatuses((prev) => ({ ...prev, [segment.id]: { state: "ready", audioKey: key, durationMs } }));
				} else {
					setStatuses((prev) => ({ ...prev, [segment.id]: { state: "idle" } }));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
		// Re-resolve when the segments, voice, or speed change.
	}, [config.segments, config.voice, config.speed]);

	return { statuses, clips, audioKeyFor, seedFromTranscript, generateSegment, generateAll };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/hooks/useVoiceover.test.ts
```
Expected: PASS (3 tests). If `renderHook`/`waitFor` are unavailable, confirm `@testing-library/react` is a devDependency (it backs other hook tests in `src/hooks/`); it is used elsewhere in the repo.

- [ ] **Step 5: Typecheck + full unit suite + lint**

Run:
```bash
npx tsc --noEmit && npx vitest run && npm run lint
```
Expected: tsc exits 0; all unit tests pass; lint exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useVoiceover.ts src/hooks/useVoiceover.test.ts
git commit -m "feat(voiceover): add useVoiceover hook (seed, synthesize, cache-resolve)"
```

---

## Self-Review

**Spec coverage (Plan 2 scope = spec §7 data model, §8.2 voiceover lib, §8.3 useVoiceover, §8.5 persistence + native-bridge cache, plus the deferred §10 offline-voices risk):**
- Offline voice loading fix (Plan 1 deferred finding) → Task 1. ✅
- `VoiceoverConfig`/`VoiceoverSegment`/`SegmentSynthStatus` types (§7.1/§7.2) → Task 2. ✅
- Content-hash `audioKey` = hash(text+voice+speed+engine+model) (§7.2) → Task 2 (`computeAudioKey`). ✅
- `segmentation.ts` — sentence split, silence-gap split, max-length cap, anchoring (§8.2) → Task 3. ✅
- `VoiceoverConfig` in undoable `EditorState` + `INITIAL_EDITOR_STATE` (§7.1) → Task 4. ✅
- Project JSON serialize + `PROJECT_VERSION` bump 2→3 + legacy default migration (§8.5) → Task 4. ✅
- Native-bridge `voiceover` domain: contracts, service (content-hash keyed, not source-keyed), client facade, wiring (§8.5) → Task 5. ✅
- `useVoiceover` — seed from transcript, drive synthesis, cache write, cache-hit resolve, status map, decoded clips (§8.3) → Task 6. ✅
- Correctly deferred (out of Plan 2 scope): `layoutVoiceover` + `VoiceoverPanel` + timeline row + instantiating `useVoiceover` in `VideoEditor.tsx` (Plan 3); Web Audio preview + export `synthesizeVoiceoverTrack` + i18n (Plan 4).

**Placeholder scan:** No TBD/TODO. Every code step contains full file contents or exact edits with anchor context; every command has expected output. Approximate line numbers are labeled "~line" and paired with an unambiguous textual anchor. ✅

**Type consistency:**
- `VoiceoverConfig`/`VoiceoverSegment`/`SegmentSynthStatus`/`VoiceoverSegmentDraft`/`DEFAULT_VOICEOVER_CONFIG`/`VOICEOVER_ENGINE` defined in Task 2, consumed unchanged in Tasks 3/4/6.
- `computeAudioKey({ text, voice, speed })` defined in Task 2; called with the same shape in Task 6 and asserted in Task 6's test.
- `segmentTranscript(CaptionSegment[], opts?) → VoiceoverSegmentDraft[]` defined in Task 3; consumed in Task 6 (`seedFromTranscript` maps drafts → `VoiceoverSegment` by adding `vo-<n>` ids).
- `VoiceoverClipResult { success; pcm?: ArrayBuffer; sampleRate?; message? }` + actions `getVoiceoverClip`/`putVoiceoverClip` defined in Task 5 contracts; `nativeBridgeClient.voiceover.getClip/putClip` (Task 5) match; consumed in Task 6.
- `setKokoroVoiceBaseUrl(url: string | null)` defined in Task 1; called in Task 1's worker edit.
- `PROJECT_VERSION = 3` and required `ProjectEditorState.voiceover` (Task 4) force the `VideoEditor.tsx` snapshot edits in the same task (compile-checked by Step 6/7).

**Ordering:** Task 1 (independent, de-risking) → Task 2 (types/key foundation) → Task 3 (segmentation, needs Task 2) → Task 4 (editor state/persistence, needs Task 2) → Task 5 (native-bridge cache, independent but placed before the hook) → Task 6 (hook, consumes 2/3/5 + Plan 1). Each task ends green (lint/tsc/tests) and is independently committable.
