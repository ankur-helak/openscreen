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
