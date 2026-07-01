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
			const useLocalModels = typeof window !== "undefined" && window.location?.protocol === "file:";
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
