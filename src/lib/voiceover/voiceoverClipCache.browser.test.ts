import { describe, expect, it } from "vitest";

/**
 * Regression guard for the view-offset invariant (Plan 2 final review): a Float32Array that is a
 * subarray view into a larger buffer must be persisted as ONLY its own bytes, never the whole
 * backing buffer. This mirrors what useVoiceover.generateSegment does before putClip.
 */
function sliceViewBytes(pcm: Float32Array): ArrayBuffer {
	return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}

describe("voiceover clip PCM view round-trip", () => {
	it("persists only the view's samples, not the whole backing buffer", () => {
		const backing = new Float32Array(100);
		for (let i = 0; i < backing.length; i++) backing[i] = i / 100;
		const view = backing.subarray(10, 34); // 24 samples, byteOffset 40
		expect(view.byteOffset).toBe(40);

		const sliced = sliceViewBytes(view);
		expect(sliced.byteLength).toBe(24 * 4); // not 100*4

		const restored = new Float32Array(sliced);
		expect(Array.from(restored)).toEqual(Array.from(view));
	});
});
