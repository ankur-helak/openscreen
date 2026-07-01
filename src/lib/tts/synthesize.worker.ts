/**
 * Web Worker running in-browser Kokoro TTS off the renderer's main thread. The
 * model is loaded once (cached) and reused across many synthesis requests, each
 * correlated by `id` — reloading the ~92 MB model per sentence would be far too
 * slow. Mirrors src/lib/captioning/transcribe.worker.ts.
 */

import type { KokoroTTS } from "kokoro-js";
import { setKokoroVoiceBaseUrl } from "@/lib/vite-stubs/kokoroVoiceFs";
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
			if (env.backends.onnx.wasm) {
				env.backends.onnx.wasm.wasmPaths = new URL("ort/", base).href;
				// Non-threaded wasm: SharedArrayBuffer isn't available under file:// (no cross-origin isolation).
				env.backends.onnx.wasm.numThreads = 1;
			}
			// kokoro-js loads voices itself (bypassing env.localModelPath); point its
			// fs/promises shim at the bundled voices dir so it reads them offline.
			setKokoroVoiceBaseUrl(
				new URL("models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/", base).href,
			);
		} else {
			// Dev (http://localhost): fetch model + wasm + voices from the remote CDN.
			env.allowLocalModels = false;
			setKokoroVoiceBaseUrl(null);
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
		// Cast to any: kokoro-js types `voice` as a string-literal union. We pass an
		// arbitrary string; kokoro-js validates it at runtime (throws on unknown ids).
		const audio = (await tts.generate(text, { voice: voice as any, speed })) as {
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
