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
