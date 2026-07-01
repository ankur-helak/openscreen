import { describe, expect, it } from "vitest";
import { buildVoiceoverBedMono } from "./bed";
import type { PlacedClip } from "./layout";

function clip(
	segmentId: string,
	audioKey: string,
	startMs: number,
	durationMs: number,
): PlacedClip {
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
