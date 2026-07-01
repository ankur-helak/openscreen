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
	const payload = [
		VOICEOVER_ENGINE,
		VOICEOVER_MODEL_TAG,
		input.voice,
		String(input.speed),
		input.text,
	].join("\x1E");
	const { h1, h2 } = cyrb53(payload);
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
