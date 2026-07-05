import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";
import { captionRegionsFromScript } from "./captionsFromScript";
import type { SegmentSynthStatus, VoiceoverSegment } from "./types";

const seg = (id: string, startMs: number, text: string): VoiceoverSegment => ({
	id,
	sourceStartMs: startMs,
	sourceEndMs: startMs + 1000,
	text,
});
const ready = (durationMs: number): SegmentSynthStatus => ({
	state: "ready",
	audioKey: "k",
	durationMs,
});

const base = {
	minWords: DEFAULT_CAPTION_SETTINGS.minWords,
	maxWords: DEFAULT_CAPTION_SETTINGS.maxWords,
	style: DEFAULT_CAPTION_SETTINGS.style,
	position: DEFAULT_CAPTION_SETTINGS.position,
	size: DEFAULT_CAPTION_SETTINGS.size,
};

describe("captionRegionsFromScript", () => {
	it("anchors captions in SOURCE time using the segment start + TTS duration", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 5000, "hello world")],
			statuses: { "vo-1": ready(2000) },
			...base,
		});
		expect(regions.length).toBeGreaterThan(0);
		expect(regions[0]!.startMs).toBe(5000); // sourceStartMs, NOT an output-time value
		expect(regions.at(-1)!.endMs).toBeLessThanOrEqual(7000); // <= start + durationMs
		expect(regions[0]!.annotationSource).toBe("auto-caption");
		expect(regions[0]!.style.fontSize).toBe(24);
	});

	it("skips segments with no generated clip", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 0, "generated"), seg("vo-2", 3000, "not generated")],
			statuses: { "vo-1": ready(1500) }, // vo-2 missing
			...base,
		});
		expect(regions.every((r) => r.content !== "not generated")).toBe(true);
		expect(regions.some((r) => r.content.includes("generated"))).toBe(true);
	});

	it("clamps a long clip so it never overlaps the next segment's anchor", () => {
		const regions = captionRegionsFromScript({
			segments: [seg("vo-1", 0, "one"), seg("vo-2", 1000, "two")],
			statuses: { "vo-1": ready(5000), "vo-2": ready(500) }, // vo-1 would run to 5000
			...base,
		});
		const first = regions.filter((r) => r.content === "one");
		expect(first.at(-1)!.endMs).toBeLessThanOrEqual(1000); // clamped before vo-2 @ 1000
	});

	it("returns nothing when no segment is ready", () => {
		expect(
			captionRegionsFromScript({ segments: [seg("vo-1", 0, "x")], statuses: {}, ...base }),
		).toEqual([]);
	});
});
