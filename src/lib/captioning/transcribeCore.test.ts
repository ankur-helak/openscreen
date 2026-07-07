import { describe, expect, it } from "vitest";

import { repairHallucinatedTail } from "./transcribeCore";

// Whisper-tiny word-timestamp passes can hallucinate a repetition loop at the end of a
// clip, stamping the trailing words with a start time PAST the real audio duration (end
// gets clamped, start does not → start > end, anchored off the timeline). See the real
// 129s recording where the last 139/441 words were all stamped startSec=137.29s.
describe("repairHallucinatedTail", () => {
	it("leaves a healthy transcript untouched", () => {
		const dur = 10;
		const segments = [
			{ startSec: 0, endSec: 1, text: "alpha" },
			{ startSec: 1, endSec: 2, text: "beta" },
			{ startSec: 9, endSec: 9.8, text: "gamma" },
		];
		expect(repairHallucinatedTail(segments, dur)).toEqual(segments);
	});

	it("relocates tail words anchored past the audio duration back within bounds", () => {
		const dur = 129.105;
		const valid = [
			{ startSec: 123.74, endSec: 124.78, text: "round." },
			{ startSec: 124.78, endSec: 125.2, text: "That's" },
		];
		const tail = ["what", "it", "means", "to", "be", "able", "to", "do", "this."].map((text) => ({
			startSec: 137.29,
			endSec: 129.105,
			text,
		}));

		const out = repairHallucinatedTail([...valid, ...tail], dur);

		// No segment may be anchored at/after the end, and every segment is well-formed.
		expect(out.every((s) => s.startSec < dur)).toBe(true);
		expect(out.every((s) => s.startSec < s.endSec)).toBe(true);
		// The real trailing words are recovered and placed in the leftover time after 125.2s.
		const recovered = out.filter((s) => s.startSec >= 125.2);
		expect(recovered.map((s) => s.text)).toEqual([
			"what",
			"it",
			"means",
			"to",
			"be",
			"able",
			"to",
			"do",
			"this.",
		]);
		expect(recovered[recovered.length - 1]!.endSec).toBeLessThanOrEqual(dur);
	});

	it("collapses a repetition loop to a single occurrence", () => {
		const dur = 130;
		const cycle = ["what", "it", "means", "to", "be", "able", "to", "do", "this."];
		const loop: { startSec: number; endSec: number; text: string }[] = [];
		for (let r = 0; r < 5; r++) {
			for (const text of cycle) loop.push({ startSec: 137.29, endSec: 130, text });
		}
		const valid = [{ startSec: 124, endSec: 125, text: "okay" }];

		const out = repairHallucinatedTail([...valid, ...loop], dur);

		const recovered = out.filter((s) => s.startSec >= 125);
		expect(recovered.map((s) => s.text)).toEqual(cycle);
	});

	it("drops the hallucinated tail when there is no room to place it", () => {
		const dur = 129.105;
		const valid = [{ startSec: 128.9, endSec: 129.105, text: "end" }];
		const tail = [{ startSec: 137.29, endSec: 129.105, text: "ghost" }];

		const out = repairHallucinatedTail([...valid, ...tail], dur);

		expect(out).toEqual(valid);
	});
});
