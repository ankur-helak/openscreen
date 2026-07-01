import { describe, expect, it } from "vitest";
import type { CaptionSegment } from "@/lib/captioning";
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
		const out = segmentTranscript([seg(0, 0.5, "part one"), seg(3, 3.5, "part two")], {
			silenceGapMs: 700,
		});
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
