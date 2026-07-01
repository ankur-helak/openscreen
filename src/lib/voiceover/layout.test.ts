import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	isAnchorTrimmed,
	type LayoutClipInput,
	layoutVoiceover,
	mapSourceToOutputMs,
} from "./layout";
import type { VoiceoverSegment } from "./types";

function seg(id: string, sourceStartMs: number): VoiceoverSegment {
	return { id, sourceStartMs, sourceEndMs: sourceStartMs + 500, text: id };
}

describe("isAnchorTrimmed", () => {
	const trims: TrimRegion[] = [{ id: "t1", startMs: 1000, endMs: 2000 }];
	it("is true when the anchor is inside a trim (start-inclusive, end-exclusive)", () => {
		expect(isAnchorTrimmed(1000, trims)).toBe(true);
		expect(isAnchorTrimmed(1500, trims)).toBe(true);
	});
	it("is false at the exclusive end and outside", () => {
		expect(isAnchorTrimmed(2000, trims)).toBe(false);
		expect(isAnchorTrimmed(500, trims)).toBe(false);
	});
});

describe("mapSourceToOutputMs", () => {
	it("subtracts fully-removed trims that end before the anchor", () => {
		const trims: TrimRegion[] = [{ id: "t1", startMs: 1000, endMs: 2000 }];
		expect(mapSourceToOutputMs(3000, trims, [])).toBe(2000); // 3000 - 1000 removed
	});
	it("compresses time saved by a speed-up region before the anchor", () => {
		// 1000ms region at 2x saves 500ms; anchor after it.
		const speed: SpeedRegion[] = [{ id: "s1", startMs: 1000, endMs: 2000, speed: 2 }];
		expect(mapSourceToOutputMs(3000, [], speed)).toBe(2500); // 3000 - 1000*(1-1/2)
	});
	it("compresses only the portion of a speed region before the anchor", () => {
		const speed: SpeedRegion[] = [{ id: "s1", startMs: 1000, endMs: 5000, speed: 2 }];
		// anchor at 3000 → 2000ms of the region elapsed → saves 1000ms
		expect(mapSourceToOutputMs(3000, [], speed)).toBe(2000);
	});
	it("never returns negative", () => {
		const trims: TrimRegion[] = [{ id: "t1", startMs: 0, endMs: 5000 }];
		expect(mapSourceToOutputMs(0, trims, [])).toBe(0);
	});
});

describe("layoutVoiceover", () => {
	const clips: Record<string, LayoutClipInput> = {
		a: { audioKey: "ka", durationMs: 1000 },
		b: { audioKey: "kb", durationMs: 1000 },
		c: { audioKey: "kc", durationMs: 1000 },
	};

	it("skips segments with no ready clip", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 0), seg("missing", 5000)],
			clipsById: { a: clips.a },
			trims: [],
			speedRegions: [],
		});
		expect(out.map((p) => p.segmentId)).toEqual(["a"]);
	});

	it("drops clips whose anchor is inside a trim", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 500), seg("b", 1500)],
			clipsById: clips,
			trims: [{ id: "t1", startMs: 1000, endMs: 2000 }],
			speedRegions: [],
		});
		expect(out.map((p) => p.segmentId)).toEqual(["a"]);
	});

	it("carries audioKey + durationMs and maps start through trims", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 3000)],
			clipsById: clips,
			trims: [{ id: "t1", startMs: 1000, endMs: 2000 }],
			speedRegions: [],
		});
		expect(out[0]).toEqual({ segmentId: "a", audioKey: "ka", startMs: 2000, durationMs: 1000 });
	});

	it("nudges overlapping clips right by the gap, in output-time order", () => {
		// a at 0 (dur 1000), b at 500 (dur 1000). gap 40 → b pushed to 1040.
		const out = layoutVoiceover({
			segments: [seg("b", 500), seg("a", 0)],
			clipsById: clips,
			trims: [],
			speedRegions: [],
			gapMs: 40,
		});
		expect(out).toEqual([
			{ segmentId: "a", audioKey: "ka", startMs: 0, durationMs: 1000 },
			{ segmentId: "b", audioKey: "kb", startMs: 1040, durationMs: 1000 },
		]);
	});

	it("accumulates drift across a dense run", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 0), seg("b", 100), seg("c", 200)],
			clipsById: clips,
			trims: [],
			speedRegions: [],
			gapMs: 40,
		});
		expect(out.map((p) => p.startMs)).toEqual([0, 1040, 2080]);
	});
});
