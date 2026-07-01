# AI Voiceover — Plan 4: Preview + Export + Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built `layoutVoiceover` reachable at runtime — a Web-Audio, timeline-synced **preview** (original audio muted) and a **replace-mode export** that synthesizes the output audio track from the generated clips — plus fold in two deferred Plan-3 cleanups and update docs.

**Architecture:** `VideoEditor` computes `layoutVoiceover(...)` **once** (memoized) and passes the same `PlacedClip[]` to *both* the preview and the exporter, so they can never disagree. A shared pure builder (`buildVoiceoverBedMono`) writes clips into a silent PCM bed at their output-time positions; **preview** wraps it in one `AudioBuffer` played by a new `useVoiceoverPlayback` hook (called inside `VideoPlayback`, which mutes the `<video>` + supplemental `<audio>`), and **export** wraps it in a 48 kHz stereo track encoded via WebCodecs `AudioEncoder` and muxed. This is the final slice — after it, voiceover works end-to-end.

**Tech Stack:** TypeScript, React (function components, `useScopedT` i18n, prop-drilling — no store), Web Audio (`AudioContext`, `OfflineAudioContext`, `AudioBufferSourceNode`), WebCodecs (`AudioEncoder`, `AudioData`), `mediabunny` muxer, Vitest (jsdom unit tier + Chromium browser tier), Biome.

## Context: this is Plan 4 of 4

Design spec: `docs/superpowers/specs/2026-07-01-ai-voiceover-replace-narration-design.md` (see especially **§8.6 export**, **§8.7 preview**, **§9 layoutVoiceover**, **§16 "Plan 4 resolved decisions"**).

1. Plan 1 — TTS engine foundation (done): `src/lib/tts/` (`getKokoroProvider()`, `KOKORO_VOICES`), Kokoro worker @ 24 kHz mono.
2. Plan 2 — Voiceover data + persistence (done): `src/lib/voiceover/` (`types.ts`, `audioKey.ts`, `segmentation.ts`), `VoiceoverConfig` in `EditorState` + project v3, native-bridge `voiceover` cache, `useVoiceover` hook.
3. Plan 3 — UI + alignment (done): `VoiceoverPanel`, timeline row, **pure `layoutVoiceover`** (`src/lib/voiceover/layout.ts`), `useClipAudition`, `voiceover` i18n namespace, `useVoiceover` instantiated in `VideoEditor.tsx`.
4. **Plan 4 — Preview + export** (this doc): shared bed builder, `useVoiceoverPlayback`, `synthesizeVoiceoverTrack`, exporter replace-mode wiring, VideoEditor/VideoPlayback integration, deferred-minor cleanups, docs.

### Already built for you to consume — do NOT rebuild

- **`layoutVoiceover`** (`src/lib/voiceover/layout.ts`): `layoutVoiceover({ segments, clipsById, trims, speedRegions, gapMs? }) → PlacedClip[]`. Exports `interface PlacedClip { segmentId: string; audioKey: string; startMs: number; durationMs: number }`, `interface LayoutClipInput { audioKey: string; durationMs: number }`, and `mapSourceToOutputMs(sourceMs, trims, speedRegions): number`. All pure, unit-tested.
- **`useVoiceover`** (`src/hooks/useVoiceover.ts`): returns `{ statuses: Record<id, SegmentSynthStatus>, clips: Record<audioKey, ResolvedClip>, audioKeyFor, seedFromTranscript, generateSegment, generateAll }`. `ResolvedClip = { pcm: Float32Array; sampleRate: number; durationMs: number }`. **`clips` keyed by audioKey; `statuses` keyed by segment id.** In `VideoEditor.tsx` these are destructured as `voiceoverStatuses` / `voiceoverClips`.
- **`SegmentSynthStatus`** (`src/lib/voiceover/types.ts`): `…| { state: "ready"; audioKey: string; durationMs: number } | …`.
- **`VideoEditor.tsx`** already holds `voiceover` (config), `voiceoverStatuses`, `voiceoverClips`, `trimRegions`, `speedRegions`, `currentTime`, `isPlaying`, `videoPlaybackRef`, and renders `<VideoPlayback … ref={videoPlaybackRef} currentTime={currentTime} isPlaying={isPlaying} trimRegions={…} speedRegions={…} />` around line 2685. `useVoiceover` is instantiated with `onChange: (updater) => pushState((prev) => ({ voiceover: updater(prev.voiceover) }))` (an inline arrow — Task 8 wraps it in `useCallback`).
- **`AudioProcessor`** (`src/lib/exporter/audioEncoder.ts`): `static selectSupportedExportCodec(sampleRate, numberOfChannels): Promise<ExportAudioCodec | null>` where `ExportAudioCodec = { encoderCodec; muxerCodec; label; sampleRate; numberOfChannels }`; instances have `cancel()` and a private `cancelled` flag.
- **`VideoMuxer`** (`src/lib/exporter/muxer.ts`): `new VideoMuxer(config, hasAudio, audioCodec)`, `initialize()`, `addAudioChunk(chunk, meta?)`, `finalize()`.
- **`StreamingVideoDecoder.getExportMetrics(frameRate, trims, speed) → { effectiveDuration, totalFrames }`** — `effectiveDuration` (seconds) is the exact output duration.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec / repo conventions.

- **Node 22.x / npm 10.x**; do not change engine pins. **`kokoro-js` pinned to exactly `1.2.1`.**
- **Renderer imports (`src/`) use the `@/*` → `src/*` alias** — never deep relative paths across features; relative sibling imports within a folder are fine. **`electron/` uses relative imports** (untouched this plan).
- **Any user-facing string** goes through `useScopedT(namespace)` and must exist in **all 13 locales** under `src/i18n/locales/<locale>/voiceover.json` (baseline `en`). A locale missing a required namespace file is dropped by `src/i18n/loader.ts`. Verify with `npm run i18n:check`.
- **Production strips `console.log`/`console.debug`** (terser `drop_console`). Prod-surviving logs use `console.warn`/`console.error`/`console.info`, tagged (`[useVoiceoverPlayback]`, `[AudioProcessor]`).
- **Security:** every `BrowserWindow` runs `contextIsolation: true`, `nodeIntegration: false` — do not weaken. Renderer/worker never require Node builtins; native features go via `nativeBridgeClient.*`, never raw IPC.
- **Kokoro output is mono Float32 PCM @ 24000 Hz.** Export audio target: **48000 Hz, 2 channels** (per §16).
- **Style:** `interface` for object shapes, `type` for unions; **no `enum`**; avoid `any`. Components are `function` declarations with an `XxxProps` interface; Tailwind via `cn()`/`cva`. Match surrounding code.
- **Single source of truth (spec §16):** preview AND export consume the SAME `PlacedClip[]` from `layoutVoiceover`, computed once in `VideoEditor`. Never re-derive placement in two places.
- **CI gates (all must stay green):** `npm run lint` (Biome — note the ONE pre-existing Plan-1 `voice as any` warning is allowed), `npx tsc --noEmit`, `npm run test`, `npx vite build`. Additionally: `npm run test:browser` (touches export/render code) and `npm run i18n:check` (adds a string).
- **Pre-existing, OUT OF SCOPE:** `npm run i18n:check` fails only on `timeline.json` `buttons.autoZoom*/autoFocusAll*` debt (present since branch start `db1c657`). Do not "fix" it here; keep the `voiceover` namespace at full parity.

---

### Task 1: Add Plan 4 export string to the `voiceover` i18n namespace (all 13 locales)

The only new user-facing string in Plan 4 is the warning shown when the user exports with voiceover enabled but nothing generated. Add it under a new `export` object in every `voiceover.json`. (The `voiceover` namespace + all locale files already exist from Plan 3.)

**Files:**
- Modify: `src/i18n/locales/en/voiceover.json`
- Modify: `src/i18n/locales/{ar,es,fr,it,ja-JP,ko-KR,ru,tr,vi,pt-BR,zh-CN,zh-TW}/voiceover.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the leaf key `export.noClipsWarning`, consumed by Task 8 via `useScopedT("voiceover")` → `voT("export.noClipsWarning")`.

- [ ] **Step 1: Add the key to the English baseline**

In `src/i18n/locales/en/voiceover.json`, add a top-level `"export"` object (keep existing keys unchanged):

```json
	"export": {
		"noClipsWarning": "Voiceover is on but no segments are generated yet — exporting the video without narration."
	}
```

- [ ] **Step 2: Add the translated key to the other 12 locales**

Add the same `"export"` object to each file, translated (keep `export` as the JSON key; translate only the value):

- `es/voiceover.json`: `"export": { "noClipsWarning": "La voz en off está activada pero aún no hay segmentos generados: se exportará el vídeo sin narración." }`
- `fr/voiceover.json`: `"export": { "noClipsWarning": "La voix off est activée mais aucun segment n'est encore généré : la vidéo sera exportée sans narration." }`
- `it/voiceover.json`: `"export": { "noClipsWarning": "La voce fuori campo è attiva ma non è stato ancora generato alcun segmento: il video verrà esportato senza narrazione." }`
- `pt-BR/voiceover.json`: `"export": { "noClipsWarning": "A narração está ativada, mas nenhum segmento foi gerado ainda — o vídeo será exportado sem narração." }`
- `ru/voiceover.json`: `"export": { "noClipsWarning": "Озвучка включена, но сегменты ещё не сгенерированы — видео будет экспортировано без озвучки." }`
- `tr/voiceover.json`: `"export": { "noClipsWarning": "Seslendirme açık ama henüz hiç segment üretilmedi — video, anlatım olmadan dışa aktarılacak." }`
- `vi/voiceover.json`: `"export": { "noClipsWarning": "Lồng tiếng đang bật nhưng chưa có đoạn nào được tạo — video sẽ được xuất mà không có lời tường thuật." }`
- `ja-JP/voiceover.json`: `"export": { "noClipsWarning": "ナレーションは有効ですが、まだセグメントが生成されていません。ナレーションなしで動画を書き出します。" }`
- `ko-KR/voiceover.json`: `"export": { "noClipsWarning": "내레이션이 켜져 있지만 아직 생성된 세그먼트가 없습니다 — 내레이션 없이 영상을 내보냅니다." }`
- `zh-CN/voiceover.json`: `"export": { "noClipsWarning": "配音已启用，但尚未生成任何片段——将导出没有旁白的视频。" }`
- `zh-TW/voiceover.json`: `"export": { "noClipsWarning": "配音已啟用，但尚未產生任何片段——將匯出沒有旁白的影片。" }`
- `ar/voiceover.json`: `"export": { "noClipsWarning": "التعليق الصوتي مُفعَّل لكن لم يتم توليد أي مقطع بعد — سيتم تصدير الفيديو بدون سرد." }`

> Add `"export"` as a sibling of the existing top-level keys (e.g. `status`, `rowHint`). Ensure valid JSON (comma placement).

- [ ] **Step 3: Verify locale parity and typecheck**

Run:
```bash
npm run i18n:check ; npx tsc --noEmit
```
Expected: `i18n:check` reports **no missing `voiceover` keys** (it still fails ONLY on the pre-existing `timeline.json` `autoZoom*/autoFocusAll*` debt — that is expected and out of scope). `tsc` exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/*/voiceover.json
git commit -m "i18n(voiceover): add export.noClipsWarning across all locales"
```

---

### Task 2: `buildVoiceoverBedMono` — shared pure bed builder

The single primitive shared by preview and export: place each clip's samples into a silent mono bed at its output-time position. Pure array math → jsdom-testable.

**Files:**
- Create: `src/lib/voiceover/bed.ts`
- Create: `src/lib/voiceover/bed.test.ts`

**Interfaces:**
- Consumes: `PlacedClip` from `./layout`.
- Produces: `buildVoiceoverBedMono(input: { placedClips: PlacedClip[]; clipSamplesByKey: Record<string, Float32Array>; sampleRate: number; totalSamples: number }): Float32Array` — a `Float32Array` of length `totalSamples`; each placed clip's samples are copied starting at `round(startMs/1000 * sampleRate)`, clamped to the bed's length; clips whose `audioKey` is absent from `clipSamplesByKey` are skipped.

- [ ] **Step 1: Write the failing test**

Create `src/lib/voiceover/bed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildVoiceoverBedMono } from "./bed";
import type { PlacedClip } from "./layout";

function clip(segmentId: string, audioKey: string, startMs: number, durationMs: number): PlacedClip {
	return { segmentId, audioKey, startMs, durationMs };
}

describe("buildVoiceoverBedMono", () => {
	it("returns an all-zero bed of the requested length when there are no clips", () => {
		const bed = buildVoiceoverBedMono({
			placedClips: [],
			clipSamplesByKey: {},
			sampleRate: 1000,
			totalSamples: 5,
		});
		expect(bed).toHaveLength(5);
		expect(Array.from(bed)).toEqual([0, 0, 0, 0, 0]);
	});

	it("writes a clip's samples at round(startMs/1000 * sampleRate)", () => {
		// sampleRate 1000 → 1 sample per ms. startMs 2 → offset 2.
		const bed = buildVoiceoverBedMono({
			placedClips: [clip("a", "ka", 2, 3)],
			clipSamplesByKey: { ka: new Float32Array([1, 2, 3]) },
			sampleRate: 1000,
			totalSamples: 8,
		});
		expect(Array.from(bed)).toEqual([0, 0, 1, 2, 3, 0, 0, 0]);
	});

	it("places multiple non-overlapping clips independently", () => {
		const bed = buildVoiceoverBedMono({
			placedClips: [clip("a", "ka", 0, 2), clip("b", "kb", 4, 2)],
			clipSamplesByKey: { ka: new Float32Array([1, 1]), kb: new Float32Array([2, 2]) },
			sampleRate: 1000,
			totalSamples: 6,
		});
		expect(Array.from(bed)).toEqual([1, 1, 0, 0, 2, 2]);
	});

	it("clamps samples that would run past the end of the bed", () => {
		const bed = buildVoiceoverBedMono({
			placedClips: [clip("a", "ka", 3, 4)],
			clipSamplesByKey: { ka: new Float32Array([1, 2, 3, 4]) },
			sampleRate: 1000,
			totalSamples: 5,
		});
		// offset 3, bed length 5 → only first 2 samples fit.
		expect(Array.from(bed)).toEqual([0, 0, 0, 1, 2]);
	});

	it("skips a placed clip whose audioKey has no samples", () => {
		const bed = buildVoiceoverBedMono({
			placedClips: [clip("a", "missing", 0, 2)],
			clipSamplesByKey: {},
			sampleRate: 1000,
			totalSamples: 3,
		});
		expect(Array.from(bed)).toEqual([0, 0, 0]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/lib/voiceover/bed.test.ts
```
Expected: FAIL — cannot resolve `./bed`.

- [ ] **Step 3: Implement `bed.ts`**

Create `src/lib/voiceover/bed.ts`:

```ts
import type { PlacedClip } from "./layout";

/**
 * Write each placed clip's samples into a silent mono bed at its output-time position.
 * Pure — shared by preview (24 kHz AudioBuffer) and export (48 kHz PCM track) so both lay
 * clips down identically. `clipSamplesByKey` must already be at `sampleRate`; clips with no
 * samples are skipped, and writes are clamped to the bed length.
 */
export function buildVoiceoverBedMono(input: {
	placedClips: PlacedClip[];
	clipSamplesByKey: Record<string, Float32Array>;
	sampleRate: number;
	totalSamples: number;
}): Float32Array {
	const bed = new Float32Array(Math.max(0, input.totalSamples));
	for (const clip of input.placedClips) {
		const samples = input.clipSamplesByKey[clip.audioKey];
		if (!samples || samples.length === 0) continue;
		const startSample = Math.round((clip.startMs / 1000) * input.sampleRate);
		if (startSample >= bed.length) continue;
		const writable = Math.min(samples.length, bed.length - startSample);
		if (writable <= 0) continue;
		bed.set(writable === samples.length ? samples : samples.subarray(0, writable), startSample);
	}
	return bed;
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
npx vitest run src/lib/voiceover/bed.test.ts
```
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceover/bed.ts src/lib/voiceover/bed.test.ts
git commit -m "feat(voiceover): add shared buildVoiceoverBedMono clip-placement builder"
```

---

### Task 3: `useClipAudition` — resume the context + add the 3 missing assertions (deferred Plan-3 minor)

Fold in Plan 3's deferred audition minors: (1) `await ctx.resume()` before `start()` so a suspended context (autoplay policy) doesn't play silence; (2) the three assertions the Plan-3 tests omitted.

**Files:**
- Modify: `src/hooks/useClipAudition.ts:34-64` (the `play` callback)
- Modify: `src/hooks/useClipAudition.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `play()` now calls `ctx.resume()` (if present) before `source.start()`.

- [ ] **Step 1: Add the three assertions + a resume assertion to the test**

In `src/hooks/useClipAudition.test.ts`, extend the `FakeAudioContext`/`FakeBufferSource` fakes and add cases. First ensure `FakeAudioContext` has a `resume` spy and `FakeBufferSource` records `stop`. Update the fakes to include (add these members if not present):

```ts
	// on FakeAudioContext:
	resume = vi.fn(async () => {});
```

Then add these tests inside the existing `describe("useClipAudition", …)`:

```ts
	it("resumes a suspended context before starting playback", async () => {
		const { result } = renderHook(() => useClipAudition());
		await act(async () => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
			await Promise.resolve();
		});
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.resume).toHaveBeenCalled();
		expect(ctx.created[0].start).toHaveBeenCalled();
	});

	it("stops the previous source when a second clip replaces it", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const first = FakeAudioContext.instances[0].created[0];
		act(() => {
			result.current.play({ pcm: new Float32Array([0.2]), sampleRate: 24000 }, "k2");
		});
		expect(first.stop).toHaveBeenCalled();
	});

	it("clears the key when a clip ends naturally", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const source = FakeAudioContext.instances[0].created[0];
		act(() => {
			source.onended?.();
		});
		expect(result.current.auditioningKey).toBeNull();
	});

	it("closes the AudioContext on unmount", () => {
		const { result, unmount } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const ctx = FakeAudioContext.instances[0];
		unmount();
		expect(ctx.close).toHaveBeenCalled();
	});
```

> If `FakeBufferSource.stop` is defined as `vi.fn(() => { this.onended?.(); })`, the "ends naturally" test still passes because `play` clears `onended` on the replaced source before calling `stop()`; the natural-end test calls `onended` directly on the live source. Keep the existing `resume` absent-safe (the hook guards `ctx.resume?.()`), but this fake defines it so the resume assertion is meaningful.

- [ ] **Step 2: Run to verify the resume test fails**

Run:
```bash
npx vitest run src/hooks/useClipAudition.test.ts -t "resumes a suspended context"
```
Expected: FAIL — `ctx.resume` not called (no resume in `play` yet).

- [ ] **Step 3: Add `ctx.resume()` to `play`**

In `src/hooks/useClipAudition.ts`, inside the `play` callback, after the context is created and before `source.start()`, resume the context. Replace the tail of `play` (from context creation to `source.start()`) with:

```ts
			if (!ctxRef.current) {
				ctxRef.current = new AudioContext();
			}
			const ctx = ctxRef.current;
			const buffer = ctx.createBuffer(1, clip.pcm.length, clip.sampleRate);
			buffer.getChannelData(0).set(clip.pcm);
			const source = ctx.createBufferSource();
			source.buffer = buffer;
			source.connect(ctx.destination);
			source.onended = () => {
				if (sourceRef.current === source) {
					sourceRef.current = null;
					setAuditioningKey(null);
				}
			};
			sourceRef.current = source;
			setAuditioningKey(key);
			// Resume first: a context created under autoplay policy starts "suspended" and would
			// otherwise play silence. Guard start on still being the current source (resume is async).
			void ctx.resume?.().finally(() => {
				if (sourceRef.current === source) {
					source.start();
				}
			});
```

> Remove the old synchronous `source.start();` line (it is replaced by the guarded start above). If `resume` is unavailable (older test fakes), `ctx.resume?.()` is `undefined` — wrap defensively: `void Promise.resolve(ctx.resume?.()).finally(...)`. Use that `Promise.resolve(...)` form so the `.finally` always runs.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/hooks/useClipAudition.test.ts
```
Expected: PASS (existing + 4 new cases). If a timing assertion flakes, wrap the triggering call in `await act(async () => { …; await Promise.resolve(); })`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useClipAudition.ts src/hooks/useClipAudition.test.ts
git commit -m "fix(voiceover): resume AudioContext before audition start; cover stop/end/unmount"
```

---

### Task 4: `synthesizeVoiceoverTrack` + `resampleMonoPcm` (exporter audio synthesis)

Add the replace-mode audio synthesis to `AudioProcessor`: build a silent 48 kHz stereo track of the output duration, place each resampled clip via the shared bed builder, encode with WebCodecs, and mux. This uses real Web Audio / WebCodecs, so it is a **browser-tier** test.

**Files:**
- Modify: `src/lib/exporter/audioEncoder.ts` (add import + `resampleMonoPcm` + `synthesizeVoiceoverTrack`)
- Create: `src/lib/exporter/audioEncoder.browser.test.ts`

**Interfaces:**
- Consumes: `PlacedClip` from `@/lib/voiceover/layout`; `buildVoiceoverBedMono` from `@/lib/voiceover/bed`; `ExportAudioCodec`, `VideoMuxer` (existing).
- Produces:
  - `export async function resampleMonoPcm(mono: Float32Array, fromRate: number, toRate: number): Promise<Float32Array>` (module-level export).
  - `AudioProcessor.prototype.synthesizeVoiceoverTrack(placedClips: PlacedClip[], clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>, outputDurationMs: number, exportCodec: ExportAudioCodec, muxer: VideoMuxer): Promise<void>`.

- [ ] **Step 1: Write the failing browser test**

Create `src/lib/exporter/audioEncoder.browser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PlacedClip } from "@/lib/voiceover/layout";
import { AudioProcessor, resampleMonoPcm } from "./audioEncoder";

// Minimal muxer stand-in that only needs addAudioChunk for this unit.
function fakeMuxer() {
	const chunks: EncodedAudioChunk[] = [];
	return {
		chunks,
		async addAudioChunk(chunk: EncodedAudioChunk) {
			chunks.push(chunk);
		},
	} as unknown as import("./muxer").VideoMuxer & { chunks: EncodedAudioChunk[] };
}

describe("resampleMonoPcm", () => {
	it("returns the same array when from and to rates match", async () => {
		const input = new Float32Array([0.1, 0.2, 0.3]);
		const out = await resampleMonoPcm(input, 24000, 24000);
		expect(out).toBe(input);
	});

	it("upsamples 24k → 48k to roughly double the length", async () => {
		const input = new Float32Array(2400).fill(0.25); // 0.1s @ 24k
		const out = await resampleMonoPcm(input, 24000, 48000);
		// ~0.1s @ 48k ≈ 4800 samples (allow small rounding slack).
		expect(out.length).toBeGreaterThan(4700);
		expect(out.length).toBeLessThan(4900);
	});
});

describe("AudioProcessor.synthesizeVoiceoverTrack", () => {
	it("encodes and muxes a stereo track for placed clips", async () => {
		const codec = await AudioProcessor.selectSupportedExportCodec(48000, 2);
		expect(codec).not.toBeNull();
		if (!codec) return;

		const pcm = new Float32Array(24000).fill(0.2); // 1s @ 24k mono
		const placedClips: PlacedClip[] = [
			{ segmentId: "vo-1", audioKey: "k1", startMs: 0, durationMs: 1000 },
			{ segmentId: "vo-2", audioKey: "k2", startMs: 2000, durationMs: 1000 },
		];
		const clipPcmByKey = {
			k1: { pcm, sampleRate: 24000 },
			k2: { pcm, sampleRate: 24000 },
		};
		const muxer = fakeMuxer();

		const processor = new AudioProcessor();
		await processor.synthesizeVoiceoverTrack(placedClips, clipPcmByKey, 3500, codec, muxer);

		expect(muxer.chunks.length).toBeGreaterThan(0);
	});

	it("produces no chunks when cancelled", async () => {
		const codec = await AudioProcessor.selectSupportedExportCodec(48000, 2);
		if (!codec) return;
		const muxer = fakeMuxer();
		const processor = new AudioProcessor();
		processor.cancel();
		await processor.synthesizeVoiceoverTrack([], {}, 1000, codec, muxer);
		expect(muxer.chunks.length).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest --config vitest.browser.config.ts run src/lib/exporter/audioEncoder.browser.test.ts
```
Expected: FAIL — `resampleMonoPcm` / `synthesizeVoiceoverTrack` not exported.

- [ ] **Step 3: Add the imports and `resampleMonoPcm` at module scope in `audioEncoder.ts`**

At the top of `src/lib/exporter/audioEncoder.ts`, add imports (keep the existing ones):

```ts
import { buildVoiceoverBedMono } from "@/lib/voiceover/bed";
import type { PlacedClip } from "@/lib/voiceover/layout";
```

Add a module-level helper (place it near the other free functions, e.g. after `downmixPlanarChannelsForExport`):

```ts
/** Resample mono PCM via OfflineAudioContext (same technique as captioning's extractMono16k). */
export async function resampleMonoPcm(
	mono: Float32Array,
	fromRate: number,
	toRate: number,
): Promise<Float32Array> {
	if (fromRate === toRate) return mono;
	if (mono.length === 0) return mono;
	const durationSec = mono.length / fromRate;
	const outLength = Math.max(1, Math.ceil(durationSec * toRate));
	const offline = new OfflineAudioContext(1, outLength, toRate);
	const buf = offline.createBuffer(1, mono.length, fromRate);
	buf.copyToChannel(Float32Array.from(mono), 0);
	const src = offline.createBufferSource();
	src.buffer = buf;
	src.connect(offline.destination);
	src.start(0);
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
}
```

- [ ] **Step 4: Add `synthesizeVoiceoverTrack` to the `AudioProcessor` class**

Inside `class AudioProcessor`, add this method (e.g. just before `cancel()`):

```ts
	/**
	 * Replace-mode audio: build a silent stereo track of the output duration, place each
	 * generated clip (resampled to the export rate) at its output-time start via the shared
	 * bed builder, then chunk-encode with WebCodecs and mux. Original source audio is ignored.
	 */
	async synthesizeVoiceoverTrack(
		placedClips: PlacedClip[],
		clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>,
		outputDurationMs: number,
		exportCodec: ExportAudioCodec,
		muxer: VideoMuxer,
	): Promise<void> {
		if (this.cancelled) return;

		const sampleRate = exportCodec.sampleRate;
		const channels = exportCodec.numberOfChannels;
		const totalSamples = Math.max(0, Math.ceil((outputDurationMs / 1000) * sampleRate));
		if (totalSamples === 0) return;

		// Resample each distinct clip to the export rate once.
		const clipSamplesByKey: Record<string, Float32Array> = {};
		for (const clip of placedClips) {
			if (this.cancelled) return;
			if (clipSamplesByKey[clip.audioKey]) continue;
			const resolved = clipPcmByKey[clip.audioKey];
			if (!resolved) continue;
			clipSamplesByKey[clip.audioKey] = await resampleMonoPcm(
				resolved.pcm,
				resolved.sampleRate,
				sampleRate,
			);
		}
		if (this.cancelled) return;

		const bed = buildVoiceoverBedMono({ placedClips, clipSamplesByKey, sampleRate, totalSamples });

		const encodeConfig: AudioEncoderConfig = {
			codec: exportCodec.encoderCodec,
			sampleRate,
			numberOfChannels: channels,
			bitrate: AUDIO_BITRATE,
		};
		const support = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!support.supported) {
			console.warn("[AudioProcessor] Voiceover audio codec not supported, skipping audio");
			return;
		}

		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => encodedChunks.push({ chunk, meta }),
			error: (e: DOMException) => console.error("[AudioProcessor] Voiceover encode error:", e),
		});
		encoder.configure(encodeConfig);

		// Emit ~0.1s planar frames, duplicating mono into each channel.
		const frameSize = Math.max(1, Math.round(sampleRate / 10));
		for (let offset = 0; offset < totalSamples && !this.cancelled; offset += frameSize) {
			const frames = Math.min(frameSize, totalSamples - offset);
			const planar = new Float32Array(frames * channels);
			for (let ch = 0; ch < channels; ch++) {
				planar.set(bed.subarray(offset, offset + frames), ch * frames);
			}
			const audioData = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: frames,
				numberOfChannels: channels,
				timestamp: Math.round((offset / sampleRate) * 1_000_000),
				data: planar.buffer,
			});
			encoder.encode(audioData);
			audioData.close();
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}
		if (this.cancelled) return;

		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}
		console.info(
			`[AudioProcessor] Voiceover track: ${placedClips.length} clips, ${encodedChunks.length} chunks`,
		);
	}
```

> `AUDIO_BITRATE` and the `ExportAudioCodec`/`VideoMuxer` types are already in this file's scope. `bed.subarray(offset, offset + frames)` is safe even on the last short frame.

- [ ] **Step 5: Run the browser test to verify it passes**

Run:
```bash
npx vitest --config vitest.browser.config.ts run src/lib/exporter/audioEncoder.browser.test.ts
```
Expected: PASS. Then typecheck: `npx tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/exporter/audioEncoder.ts src/lib/exporter/audioEncoder.browser.test.ts
git commit -m "feat(voiceover): synthesize replace-mode export audio track (resample + encode + mux)"
```

---

### Task 5: Wire replace-mode into `VideoExporter` + source-copy blocker

Add the `voiceover` config field, branch the audio finalization to replace mode, and block the source-copy fast path when replace mode is active (otherwise a zero-edit + voiceover export would copy the original audio).

**Files:**
- Modify: `src/lib/exporter/videoExporter.ts` (config type, helper, blocker, audio branch)
- Modify: `src/lib/exporter/videoExporter.test.ts` (blocker cases)

**Interfaces:**
- Consumes: `PlacedClip` (`@/lib/voiceover/layout`); `AudioProcessor.synthesizeVoiceoverTrack` (Task 4); `AudioProcessor.selectSupportedExportCodec`; `getExportMetrics`.
- Produces: `VideoExporterConfig.voiceover?: { enabled: boolean; placedClips: PlacedClip[]; clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }> }`; exported behavior: `getSourceCopyFastPathBlockers` returns a blocker string containing `"voiceover"` when `voiceover.enabled && voiceover.placedClips.length > 0`.

- [ ] **Step 1: Write the failing blocker tests**

In `src/lib/exporter/videoExporter.test.ts`, add cases (the `createConfig` helper + `getSourceCopyFastPathBlockers` are already imported at the top of the file):

```ts
describe("voiceover replace mode + source-copy fast path", () => {
	const videoInfo = { width: 1920, height: 1080 };

	it("blocks the source-copy fast path when voiceover replace mode has clips", () => {
		const blockers = getSourceCopyFastPathBlockers(
			createConfig({
				voiceover: {
					enabled: true,
					placedClips: [{ segmentId: "vo-1", audioKey: "k1", startMs: 0, durationMs: 1000 }],
					clipPcmByKey: {},
				},
			}),
			videoInfo,
		);
		expect(blockers.some((b) => b.includes("voiceover"))).toBe(true);
	});

	it("does not block when voiceover is enabled but has no clips", () => {
		const blockers = getSourceCopyFastPathBlockers(
			createConfig({ voiceover: { enabled: true, placedClips: [], clipPcmByKey: {} } }),
			videoInfo,
		);
		expect(blockers.some((b) => b.includes("voiceover"))).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/lib/exporter/videoExporter.test.ts -t "voiceover replace mode"
```
Expected: FAIL — `voiceover` is not a known config property (type error) / no blocker produced.

- [ ] **Step 3: Add the config field + import**

In `src/lib/exporter/videoExporter.ts`, add the import (with the other type imports):

```ts
import type { PlacedClip } from "@/lib/voiceover/layout";
```

Add the field to `VideoExporterConfig` (e.g. after `speedRegions?: SpeedRegion[];`):

```ts
	voiceover?: {
		enabled: boolean;
		placedClips: PlacedClip[];
		clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>;
	};
```

- [ ] **Step 4: Add the replace-mode predicate + source-copy blocker**

In `src/lib/exporter/videoExporter.ts`, add a module-level helper near `hasNativeCursorOverlay`:

```ts
function hasVoiceoverReplacement(config: VideoExporterConfig): boolean {
	return Boolean(config.voiceover?.enabled && config.voiceover.placedClips.length > 0);
}
```

In `getSourceCopyFastPathBlockers`, add (near the other `blockers.push` lines):

```ts
	if (hasVoiceoverReplacement(config)) blockers.push("voiceover replace mode is enabled");
```

- [ ] **Step 5: Branch the audio finalization to replace mode**

In `exportWithEncoderPreference`, replace the audio-codec selection block (currently:)

```ts
			const sourceDemuxer = streamingDecoder.getDemuxer();
			const audioExportCodec =
				videoInfo.hasAudio && sourceDemuxer
					? await AudioProcessor.selectSupportedExportCodecForSource(sourceDemuxer)
					: null;
			if (videoInfo.hasAudio && !audioExportCodec) {
				console.warn("[VideoExporter] No supported audio export codec, exporting video-only.");
			}
```

with:

```ts
			const voiceoverReplace = hasVoiceoverReplacement(this.config);
			const sourceDemuxer = streamingDecoder.getDemuxer();
			const audioExportCodec = voiceoverReplace
				? await AudioProcessor.selectSupportedExportCodec(48000, 2)
				: videoInfo.hasAudio && sourceDemuxer
					? await AudioProcessor.selectSupportedExportCodecForSource(sourceDemuxer)
					: null;
			if (voiceoverReplace && !audioExportCodec) {
				console.warn("[VideoExporter] No supported audio codec for voiceover, exporting video-only.");
			} else if (!voiceoverReplace && videoInfo.hasAudio && !audioExportCodec) {
				console.warn("[VideoExporter] No supported audio export codec, exporting video-only.");
			}
```

Then replace the final audio block (currently:)

```ts
			if (hasAudio && audioExportCodec && !this.cancelled) {
				const demuxer = streamingDecoder.getDemuxer();
				if (demuxer) {
					console.log("[VideoExporter] Processing audio track...");
					this.audioProcessor = new AudioProcessor();
					await this.audioProcessor.process(
						demuxer,
						muxer,
						this.config.videoUrl,
						this.config.trimRegions,
						this.config.speedRegions,
						videoInfo.duration,
						audioExportCodec,
					);
				}
			}
```

with:

```ts
			if (voiceoverReplace && audioExportCodec && !this.cancelled) {
				console.log("[VideoExporter] Synthesizing voiceover audio track...");
				const { effectiveDuration } = streamingDecoder.getExportMetrics(
					this.config.frameRate,
					this.config.trimRegions,
					this.config.speedRegions,
				);
				this.audioProcessor = new AudioProcessor();
				await this.audioProcessor.synthesizeVoiceoverTrack(
					this.config.voiceover!.placedClips,
					this.config.voiceover!.clipPcmByKey,
					effectiveDuration * 1000,
					audioExportCodec,
					muxer,
				);
			} else if (!voiceoverReplace && hasAudio && audioExportCodec && !this.cancelled) {
				const demuxer = streamingDecoder.getDemuxer();
				if (demuxer) {
					console.log("[VideoExporter] Processing audio track...");
					this.audioProcessor = new AudioProcessor();
					await this.audioProcessor.process(
						demuxer,
						muxer,
						this.config.videoUrl,
						this.config.trimRegions,
						this.config.speedRegions,
						videoInfo.duration,
						audioExportCodec,
					);
				}
			}
```

> `hasAudio` is already `Boolean(audioExportCodec)` a few lines above, so in replace mode the muxer is constructed with the voiceover codec and an audio track. No other change to the muxer construction is needed.

- [ ] **Step 6: Run tests + typecheck**

Run:
```bash
npx vitest run src/lib/exporter/videoExporter.test.ts && npx tsc --noEmit
```
Expected: PASS (existing + 2 new blocker cases); `tsc` 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/exporter/videoExporter.ts src/lib/exporter/videoExporter.test.ts
git commit -m "feat(voiceover): export replace-mode branch + source-copy blocker"
```

---

### Task 6: `useVoiceoverPlayback` — timeline-synced preview hook

The preview: one `AudioBuffer` (bed + clips at output positions), played by one source, started at `offset = mapSourceToOutputMs(video.currentTime)`, with a bounded soft re-sync to cap drift. Audio-only; muting the `<video>` is Task 7. Tested with a mocked `AudioContext` + a fake video element.

**Files:**
- Create: `src/hooks/useVoiceoverPlayback.ts`
- Create: `src/hooks/useVoiceoverPlayback.test.ts`

**Interfaces:**
- Consumes: `buildVoiceoverBedMono` (`@/lib/voiceover/bed`); `mapSourceToOutputMs`, `PlacedClip` (`@/lib/voiceover/layout`); `TrimRegion`, `SpeedRegion` (`@/components/video-editor/types`).
- Produces:
  - `interface UseVoiceoverPlaybackParams { video: HTMLVideoElement | null; enabled: boolean; isPlaying: boolean; isScrubbing: boolean; placedClips: PlacedClip[]; clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>; trims: TrimRegion[]; speedRegions: SpeedRegion[] }`
  - `function useVoiceoverPlayback(params: UseVoiceoverPlaybackParams): void`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useVoiceoverPlayback.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedClip } from "@/lib/voiceover/layout";
import { useVoiceoverPlayback } from "./useVoiceoverPlayback";

class FakeBufferSource {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	connect = vi.fn();
	start = vi.fn();
	stop = vi.fn();
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	currentTime = 0;
	destination = {};
	created: FakeBufferSource[] = [];
	resume = vi.fn(async () => {});
	close = vi.fn(async () => {});
	constructor() {
		FakeAudioContext.instances.push(this);
	}
	createBuffer(_channels: number, length: number, sampleRate: number) {
		return { length, sampleRate, duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
	}
	createBufferSource() {
		const s = new FakeBufferSource();
		this.created.push(s);
		return s as unknown as AudioBufferSourceNode;
	}
}

function fakeVideo(currentTimeSec: number) {
	return { currentTime: currentTimeSec } as unknown as HTMLVideoElement;
}

const clips: PlacedClip[] = [{ segmentId: "vo-1", audioKey: "k1", startMs: 0, durationMs: 2000 }];
const clipPcmByKey = { k1: { pcm: new Float32Array(48000).fill(0.2), sampleRate: 24000 } };

function baseParams(over: Partial<Parameters<typeof useVoiceoverPlayback>[0]> = {}) {
	return {
		video: fakeVideo(0),
		enabled: true,
		isPlaying: false,
		isScrubbing: false,
		placedClips: clips,
		clipPcmByKey,
		trims: [],
		speedRegions: [],
		...over,
	};
}

beforeEach(() => {
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("useVoiceoverPlayback", () => {
	it("starts a source at the mapped offset when playing", () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), { initialProps: baseParams() });
		act(() => {
			rerender(baseParams({ video: fakeVideo(0.5), isPlaying: true }));
		});
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.resume).toHaveBeenCalled();
		expect(ctx.created.at(-1)?.start).toHaveBeenCalled();
		// started with offset ≈ 0.5s (second start arg)
		const call = ctx.created.at(-1)?.start.mock.calls.at(-1);
		expect(call?.[1]).toBeCloseTo(0.5, 2);
	});

	it("stops playback on pause", () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ isPlaying: true }),
		});
		const started = FakeAudioContext.instances[0].created.at(-1);
		act(() => {
			rerender(baseParams({ isPlaying: false }));
		});
		expect(started?.stop).toHaveBeenCalled();
	});

	it("stays silent while scrubbing", () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ isPlaying: true }),
		});
		const startedBefore = FakeAudioContext.instances[0].created.length;
		act(() => {
			rerender(baseParams({ isPlaying: true, isScrubbing: true }));
		});
		const src = FakeAudioContext.instances[0].created.at(startedBefore - 1);
		expect(src?.stop).toHaveBeenCalled();
	});

	it("does not create a context when disabled", () => {
		renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ enabled: false, isPlaying: true }),
		});
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	it("re-syncs when drift exceeds the threshold", () => {
		vi.useFakeTimers();
		const video = fakeVideo(0);
		const params = baseParams({ video, isPlaying: true });
		renderHook((p) => useVoiceoverPlayback(p), { initialProps: params });
		const ctx = FakeAudioContext.instances[0];
		const firstSourceCount = ctx.created.length;
		// Advance the audio clock far past the video clock → large positive drift.
		ctx.currentTime = 2; // buffer thinks we're 2s in…
		(video as { currentTime: number }).currentTime = 0.5; // …but video is only 0.5s in.
		act(() => {
			vi.advanceTimersByTime(600); // one re-sync tick (interval 500ms)
		});
		expect(ctx.created.length).toBeGreaterThan(firstSourceCount); // a corrected source was created
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/hooks/useVoiceoverPlayback.test.ts
```
Expected: FAIL — cannot resolve `./useVoiceoverPlayback`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useVoiceoverPlayback.ts`:

```ts
import { useEffect, useRef } from "react";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { buildVoiceoverBedMono } from "@/lib/voiceover/bed";
import { mapSourceToOutputMs, type PlacedClip } from "@/lib/voiceover/layout";

/** Preview plays clips at their native 24 kHz; the browser resamples to the device rate. */
const PREVIEW_RATE = 24000;
/** How often to check preview drift while playing (ms). */
const RESYNC_INTERVAL_MS = 500;
/** Restart the buffer if audio/video drift exceeds this (seconds). */
const DRIFT_THRESHOLD_SEC = 0.1;

export interface UseVoiceoverPlaybackParams {
	video: HTMLVideoElement | null;
	enabled: boolean;
	isPlaying: boolean;
	isScrubbing: boolean;
	placedClips: PlacedClip[];
	clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>;
	trims: TrimRegion[];
	speedRegions: SpeedRegion[];
}

/**
 * Timeline-synced voiceover preview (spec §8.7/§16). Builds ONE output-time AudioBuffer from the
 * shared bed builder and plays it with one source, started at the output-time offset mapped from
 * the video clock. Output time advances at ~1× wall-clock during playback, so a single buffer stays
 * aligned; a bounded soft re-sync caps drift from trim-skip seek latency + clock skew. Audio only —
 * the caller mutes the <video>/supplemental <audio>.
 */
export function useVoiceoverPlayback(params: UseVoiceoverPlaybackParams): void {
	const { video, enabled, isPlaying, isScrubbing, placedClips, clipPcmByKey, trims, speedRegions } =
		params;

	const ctxRef = useRef<AudioContext | null>(null);
	const bufferRef = useRef<AudioBuffer | null>(null);
	const sourceRef = useRef<AudioBufferSourceNode | null>(null);
	const startedAtCtxRef = useRef(0);
	const startedAtOffsetRef = useRef(0);
	// Latest layout inputs for the re-sync interval without re-subscribing it.
	const trimsRef = useRef(trims);
	trimsRef.current = trims;
	const speedRef = useRef(speedRegions);
	speedRef.current = speedRegions;
	const videoRef = useRef(video);
	videoRef.current = video;

	const stopSource = () => {
		const source = sourceRef.current;
		sourceRef.current = null;
		if (source) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// already stopped
			}
		}
	};

	const startSource = (offsetSec: number) => {
		const ctx = ctxRef.current;
		const buffer = bufferRef.current;
		if (!ctx || !buffer) return;
		if (offsetSec >= buffer.duration) return; // nothing left to play
		stopSource();
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		source.onended = () => {
			if (sourceRef.current === source) sourceRef.current = null;
		};
		sourceRef.current = source;
		startedAtCtxRef.current = ctx.currentTime;
		startedAtOffsetRef.current = Math.max(0, offsetSec);
		void Promise.resolve(ctx.resume?.()).finally(() => {
			if (sourceRef.current === source) {
				try {
					source.start(ctx.currentTime, Math.max(0, offsetSec));
				} catch (error) {
					console.warn("[useVoiceoverPlayback] start failed:", error);
				}
			}
		});
	};

	const outputOffsetSec = (): number => {
		const v = videoRef.current;
		if (!v) return 0;
		return mapSourceToOutputMs(v.currentTime * 1000, trimsRef.current, speedRef.current) / 1000;
	};

	// Build (or clear) the output-time buffer when enabled/placements/clips change. Declared BEFORE
	// the scheduling effect so it runs first in the same commit — the scheduler then reads a fresh
	// bufferRef. (It shares placedClips/clipPcmByKey deps with the scheduler, so both re-run together.)
	// biome-ignore lint/correctness/useExhaustiveDependencies: clipPcmByKey/placedClips identity drives rebuilds.
	useEffect(() => {
		let buffer: AudioBuffer | null = null;
		if (enabled && placedClips.length > 0) {
			if (!ctxRef.current) ctxRef.current = new AudioContext();
			const ctx = ctxRef.current;
			const clipSamplesByKey: Record<string, Float32Array> = {};
			for (const clip of placedClips) {
				const resolved = clipPcmByKey[clip.audioKey];
				if (resolved && resolved.sampleRate === PREVIEW_RATE) {
					clipSamplesByKey[clip.audioKey] = resolved.pcm;
				}
			}
			const endMs = placedClips.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0);
			const totalSamples = Math.ceil((endMs / 1000) * PREVIEW_RATE);
			if (totalSamples > 0) {
				const bed = buildVoiceoverBedMono({
					placedClips,
					clipSamplesByKey,
					sampleRate: PREVIEW_RATE,
					totalSamples,
				});
				buffer = ctx.createBuffer(1, bed.length, PREVIEW_RATE);
				buffer.getChannelData(0).set(bed);
			}
		}
		bufferRef.current = buffer;
	}, [enabled, placedClips, clipPcmByKey]);

	// Start/stop the single source on transport changes. Re-anchor triggers are enabled/isPlaying/
	// isScrubbing (+ layout via placedClips/clipPcmByKey) — NOT raw seeked, so trim-skips don't glitch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: start/stop/offset closures + bufferRef read are intentional.
	useEffect(() => {
		if (!enabled || !video || !bufferRef.current || isScrubbing || !isPlaying) {
			stopSource();
			return;
		}
		startSource(outputOffsetSec());
		return stopSource;
	}, [enabled, video, isPlaying, isScrubbing, placedClips, clipPcmByKey]);

	// Bounded soft re-sync: while playing, cap drift between the buffer position and the video clock.
	// biome-ignore lint/correctness/useExhaustiveDependencies: start/offset closures + refs are intentional.
	useEffect(() => {
		if (!enabled || !isPlaying || isScrubbing) return;
		const id = window.setInterval(() => {
			const ctx = ctxRef.current;
			const source = sourceRef.current;
			if (!ctx || !source) return;
			const actual = startedAtOffsetRef.current + (ctx.currentTime - startedAtCtxRef.current);
			const expected = outputOffsetSec();
			if (Math.abs(actual - expected) > DRIFT_THRESHOLD_SEC) {
				startSource(expected);
			}
		}, RESYNC_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [enabled, isPlaying, isScrubbing]);

	// Release the context on unmount (inline stop so the effect needs no closure deps).
	useEffect(() => {
		return () => {
			const source = sourceRef.current;
			sourceRef.current = null;
			if (source) {
				source.onended = null;
				try {
					source.stop();
				} catch {
					// already stopped
				}
			}
			if (ctxRef.current) {
				void ctxRef.current.close();
				ctxRef.current = null;
			}
		};
	}, []);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/hooks/useVoiceoverPlayback.test.ts
```
Expected: PASS (all cases). If the "re-syncs when drift" case is timing-sensitive, confirm the interval fires under fake timers; keep `DRIFT_THRESHOLD_SEC`/`RESYNC_INTERVAL_MS` as written so the test's 600 ms advance crosses one tick.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useVoiceoverPlayback.ts src/hooks/useVoiceoverPlayback.test.ts
git commit -m "feat(voiceover): add useVoiceoverPlayback timeline-synced preview hook"
```

---

### Task 7: Integrate preview into `VideoPlayback` — call the hook + mute source audio

Wire the hook into `VideoPlayback`, mute the `<video>`, and gate the supplemental `<audio>` off when voiceover is enabled. No unit test (Pixi/media-heavy, consistent with Plan 3's `VideoPlayback` policy); gates are tsc/lint/build + a manual verify note.

**Files:**
- Modify: `src/components/video-editor/VideoPlayback.tsx`

**Interfaces:**
- Consumes: `useVoiceoverPlayback` (Task 6); `PlacedClip` (`@/lib/voiceover/layout`).
- Produces: new `VideoPlaybackProps` fields `voiceoverEnabled?: boolean`, `voiceoverPlacedClips?: PlacedClip[]`, `voiceoverClipPcmByKey?: Record<string, { pcm: Float32Array; sampleRate: number }>` (consumed by Task 8).

- [ ] **Step 1: Add imports**

At the top of `src/components/video-editor/VideoPlayback.tsx`, add:

```ts
import { useVoiceoverPlayback } from "@/hooks/useVoiceoverPlayback";
import type { PlacedClip } from "@/lib/voiceover/layout";
```

- [ ] **Step 2: Add the three props to `VideoPlaybackProps`**

In the `interface VideoPlaybackProps { … }` block, add:

```ts
	voiceoverEnabled?: boolean;
	voiceoverPlacedClips?: PlacedClip[];
	voiceoverClipPcmByKey?: Record<string, { pcm: Float32Array; sampleRate: number }>;
```

- [ ] **Step 3: Destructure the props**

In the component's destructured props list (where `trimRegions = []`, `speedRegions = []`, etc. are pulled), add:

```ts
			voiceoverEnabled = false,
			voiceoverPlacedClips = [],
			voiceoverClipPcmByKey = {},
```

- [ ] **Step 4: Call the preview hook**

Inside the component body (after the refs are declared — e.g. near the other hook calls, after `hasNativeCursorRecording`), add:

```ts
		useVoiceoverPlayback({
			video: videoReady ? videoRef.current : null,
			enabled: voiceoverEnabled,
			isPlaying,
			isScrubbing,
			placedClips: voiceoverPlacedClips,
			clipPcmByKey: voiceoverClipPcmByKey,
			trims: trimRegions,
			speedRegions,
		});

		// Mute the source narration whenever voiceover replaces it.
		useEffect(() => {
			const video = videoRef.current;
			if (video) video.muted = voiceoverEnabled;
		}, [voiceoverEnabled, videoReady]);
```

> `isScrubbing` is the existing state (declared as `const [isScrubbing, setIsScrubbing] = useState(false)`), `videoReady` is the existing state, and `isPlaying`/`trimRegions`/`speedRegions` are props already in scope. Passing `videoReady ? videoRef.current : null` makes the hook re-run once the element is ready.

- [ ] **Step 5: Gate the supplemental audio off when voiceover is enabled**

In the supplemental-audio effect (the one that starts around line 1128: `const supplementalAudio = supplementalAudioRef.current; …`), add an early bail at the top of the effect body, and add `voiceoverEnabled` to its dependency array:

```ts
		useEffect(() => {
			const video = videoRef.current;
			const supplementalAudio = supplementalAudioRef.current;
			if (!video || !supplementalAudio || !supplementalAudioPath) {
				return;
			}
			if (voiceoverEnabled) {
				supplementalAudio.pause();
				return;
			}
			// …existing body unchanged…
		}, [currentTime, isPlaying, speedRegions, supplementalAudioPath, voiceoverEnabled]);
```

Also, in the `useImperativeHandle` `play()` method, guard the supplemental-audio playback so it does not start under voiceover. Change the block that plays `supplementalAudio` to:

```ts
					const supplementalAudio = supplementalAudioRef.current;
					if (supplementalAudio && !voiceoverEnabled) {
						supplementalAudio.currentTime = vid.currentTime;
						supplementalAudio.playbackRate = vid.playbackRate;
						await supplementalAudio.play().catch(() => {
							// The main video remains the source of truth for playback state.
						});
					}
```

> `useImperativeHandle` must include `voiceoverEnabled` in its dependency array if one is present; if it currently has `[]` or no deps, leave it — but verify the closure reads the latest `voiceoverEnabled` (React re-creates the handle each render by default when no deps array is given). If the existing call passes no deps array, no change needed; if it passes `[]`, add `voiceoverEnabled`.

- [ ] **Step 6: Typecheck, lint, build**

Run:
```bash
npx tsc --noEmit && npm run lint && npx vite build
```
Expected: `tsc` 0; lint passes (the single pre-existing `voice as any` warning is allowed); build 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/video-editor/VideoPlayback.tsx
git commit -m "feat(voiceover): wire timeline-synced preview into VideoPlayback (+mute source)"
```

---

### Task 8: Integrate in `VideoEditor` — placements memo, preview props, exporter config, cleanups

Compute the single `PlacedClip[]` once and feed both preview and export; `useCallback` the `useVoiceover` `onChange`; warn on export-with-no-clips.

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx`

**Interfaces:**
- Consumes: `layoutVoiceover`, `LayoutClipInput` (`@/lib/voiceover/layout`); `VideoPlayback` voiceover props (Task 7); `VideoExporterConfig.voiceover` (Task 5); `useScopedT("voiceover")`.
- Produces: passes `voiceoverEnabled`/`voiceoverPlacedClips`/`voiceoverClipPcmByKey` to `<VideoPlayback>` and `voiceover` to the `VideoExporter` config.

- [ ] **Step 1: Add imports + the voiceover scoped translator**

At the top of `src/components/video-editor/VideoEditor.tsx`, add:

```ts
import { type LayoutClipInput, layoutVoiceover } from "@/lib/voiceover/layout";
```

Near the other `useScopedT` calls (`const t = useScopedT("editor")`), add:

```ts
	const voT = useScopedT("voiceover");
```

- [ ] **Step 2: `useCallback` the `useVoiceover` onChange (deferred Plan-3 minor)**

Find the `useVoiceover({ … })` call. Above it, add:

```ts
	const handleVoiceoverChange = useCallback(
		(updater: (prev: import("@/lib/voiceover/types").VoiceoverConfig) => import("@/lib/voiceover/types").VoiceoverConfig) =>
			pushState((prev) => ({ voiceover: updater(prev.voiceover) })),
		[pushState],
	);
```

Then change the hook's `onChange` from the inline arrow to `onChange: handleVoiceoverChange,`.

> If `VoiceoverConfig` is already imported at the top of the file, use the bare type name instead of the inline `import("…")` form to match the file style.

- [ ] **Step 3: Compute the single placements memo + preview pcm map**

After `useVoiceover(...)` (so `voiceover`, `voiceoverStatuses`, `voiceoverClips`, `trimRegions`, `speedRegions` are in scope), add:

```ts
	const voiceoverPlacedClips = useMemo(() => {
		if (!voiceover.enabled) return [];
		const clipsById: Record<string, LayoutClipInput> = {};
		for (const seg of voiceover.segments) {
			const status = voiceoverStatuses[seg.id];
			if (status?.state === "ready") {
				clipsById[seg.id] = { audioKey: status.audioKey, durationMs: status.durationMs };
			}
		}
		return layoutVoiceover({
			segments: voiceover.segments,
			clipsById,
			trims: trimRegions,
			speedRegions,
		});
	}, [voiceover.enabled, voiceover.segments, voiceoverStatuses, trimRegions, speedRegions]);
```

> `voiceoverClips` (keyed by audioKey → `{ pcm, sampleRate, durationMs }`) is already structurally compatible with the `Record<audioKey, { pcm; sampleRate }>` the preview/export expect — pass it directly.

- [ ] **Step 4: Pass the preview props to `<VideoPlayback>`**

In the `<VideoPlayback … />` JSX (around line 2685), add:

```tsx
										voiceoverEnabled={voiceover.enabled}
										voiceoverPlacedClips={voiceoverPlacedClips}
										voiceoverClipPcmByKey={voiceoverClips}
```

- [ ] **Step 5: Thread voiceover into the exporter config + warn on no-clips**

In the MP4 export handler, immediately before `const exporter = new VideoExporter({ … });` (around line 2097), add the warning:

```ts
						if (voiceover.enabled && voiceoverPlacedClips.length === 0) {
							toast.warning(voT("export.noClipsWarning"));
						}
```

Then add the config field inside the `new VideoExporter({ … })` object (e.g. after `speedRegions,`):

```ts
							voiceover: voiceover.enabled
								? {
										enabled: true,
										placedClips: voiceoverPlacedClips,
										clipPcmByKey: voiceoverClips,
									}
								: undefined,
```

- [ ] **Step 6: Typecheck, lint, test, build**

Run:
```bash
npx tsc --noEmit && npm run lint && npm run test && npx vite build
```
Expected: `tsc` 0; lint passes (pre-existing `voice as any` warning only); unit suite green; build 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(voiceover): feed one layoutVoiceover result to preview + export; useCallback onChange; no-clips warning"
```

---

### Task 9: Docs + folder CLAUDE.md + final gates

Update the folder guidance and run the full gate suite.

**Files:**
- Modify: `src/CLAUDE.md`
- Modify: `.superpowers/sdd/progress.md` (managed by the execution skill — archive Plan 3, start Plan 4)

- [ ] **Step 1: Update `src/CLAUDE.md`**

In the `hooks/` bullet, add `useVoiceoverPlayback` (timeline-synced voiceover preview) alongside `useClipAudition`. In the `lib/` → `voiceover/` note, mention that `layoutVoiceover` now has runtime consumers (preview + export) and the shared `bed.ts` builder. In the `exporter/` note, mention the voiceover **replace-mode** audio path (`synthesizeVoiceoverTrack`). Keep it to one added clause per bullet, matching the file's terse style.

- [ ] **Step 2: Run the full gate suite**

Run:
```bash
npm run lint ; npx tsc --noEmit ; npm run test ; npx vite build ; npm run test:browser ; npm run i18n:check
```
Expected:
- `lint`: passes (the single pre-existing Plan-1 `voice as any` warning is allowed).
- `tsc`: 0.
- `test`: all green (adds bed / useClipAudition / useVoiceoverPlayback / videoExporter cases).
- `vite build`: 0.
- `test:browser`: green (adds `audioEncoder.browser.test.ts`).
- `i18n:check`: fails ONLY on the pre-existing `timeline.json` `autoZoom*/autoFocusAll*` debt (voiceover namespace at full parity). This is expected and out of scope.

- [ ] **Step 3: Commit**

```bash
git add src/CLAUDE.md
git commit -m "docs(voiceover): note preview hook + replace-mode export in src/CLAUDE.md"
```

---

## Post-plan follow-up (not a task; run after the branch is green)

Per spec §16 and the project memory: run a **network-disabled** `npm run build:mac` and confirm Kokoro voices load from the bundled assets (true offline), which has been deferred since Plan 1. This is a manual verification, not a code change.

## Self-review notes

- **Spec coverage:** §8.6 export → Tasks 4–5, 8; §8.7 preview → Tasks 6–8; §9 shared `layoutVoiceover` consumption → Task 8 (single memo to both); §16 single-source-of-truth → Task 8; §16 bounded re-sync → Task 6; §16 folded minors → Tasks 3 (audition) + 8 (onChange useCallback); §11 i18n → Task 1; docs → Task 9.
- **Type consistency:** `PlacedClip`/`LayoutClipInput` come from `@/lib/voiceover/layout`; `buildVoiceoverBedMono` signature identical across Tasks 2/4/6; `synthesizeVoiceoverTrack` signature identical across Tasks 4/5; `voiceover` config shape identical across Tasks 5/8; `useVoiceoverPlayback` params identical across Tasks 6/7.
- **Placeholders:** none — every code step shows full content.
