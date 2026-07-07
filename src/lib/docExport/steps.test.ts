import { describe, expect, it } from "vitest";
import { deriveSteps } from "./steps";
import type { NarrationSegment } from "./types";

const narration: NarrationSegment[] = [
	{ sourceStartMs: 0, sourceEndMs: 900, text: "Open the homepage." },
	{ sourceStartMs: 1000, sourceEndMs: 1900, text: "Click create." },
	{ sourceStartMs: 5000, sourceEndMs: 5900, text: "Fill in the details." },
];

describe("deriveSteps", () => {
	it("coalesces nearby interactions and attaches the overlapping narration", () => {
		const steps = deriveSteps({
			clicks: [100, 200, 5100], // 100 & 200 coalesce; 5100 is a second step
			zoomStarts: [],
			annotationStarts: [],
			narration,
			endMs: 6000,
			coalesceMs: 1500,
		});
		expect(steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
		expect(steps[0].screenshotMs).toBe(100);
		expect(steps[0].transcriptText).toContain("Open the homepage.");
		expect(steps[0].transcriptText).toContain("Click create.");
		expect(steps[1].screenshotMs).toBe(5100);
		expect(steps[1].transcriptText).toBe("Fill in the details.");
	});

	it("falls back to narration starts when there are no interactions", () => {
		const steps = deriveSteps({
			clicks: [],
			zoomStarts: [],
			annotationStarts: [],
			narration,
			endMs: 6000,
			coalesceMs: 1, // don't merge — one step per narration segment
		});
		expect(steps).toHaveLength(3);
		expect(steps[0].screenshotMs).toBe(0);
		expect(steps[2].screenshotMs).toBe(5000);
	});

	it("returns [] when there is nothing to anchor", () => {
		expect(
			deriveSteps({ clicks: [], zoomStarts: [], annotationStarts: [], narration: [], endMs: 0 }),
		).toEqual([]);
	});

	it("caps the number of steps", () => {
		const clicks = Array.from({ length: 100 }, (_, i) => i * 10_000);
		const steps = deriveSteps({
			clicks,
			zoomStarts: [],
			annotationStarts: [],
			narration: [],
			endMs: 1_000_000,
			coalesceMs: 1,
			maxSteps: 20,
		});
		expect(steps.length).toBeLessThanOrEqual(20);
	});
});
