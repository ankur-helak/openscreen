import { describe, expect, it } from "vitest";
import { resolveTranscriptLoadPlan } from "./loadPlan";

describe("resolveTranscriptLoadPlan", () => {
	it("prefers project captions over everything", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: true,
			hasCaptionDraft: true,
			hasCachedTranscript: true,
		});
		expect(plan.captionSource).toBe("project");
	});

	it("falls back to an autosave draft when there are no project captions", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: false,
			hasCaptionDraft: true,
			hasCachedTranscript: false,
		});
		expect(plan.captionSource).toBe("draft");
	});

	it("uses no caption overlays when neither project nor draft captions exist", () => {
		const plan = resolveTranscriptLoadPlan({
			hasProjectCaptions: false,
			hasCaptionDraft: false,
			hasCachedTranscript: true,
		});
		expect(plan.captionSource).toBe("none");
	});

	it("needs transcription only when no transcript is cached", () => {
		expect(
			resolveTranscriptLoadPlan({
				hasProjectCaptions: false,
				hasCaptionDraft: false,
				hasCachedTranscript: false,
			}).needsTranscription,
		).toBe(true);
		expect(
			resolveTranscriptLoadPlan({
				hasProjectCaptions: true,
				hasCaptionDraft: false,
				hasCachedTranscript: true,
			}).needsTranscription,
		).toBe(false);
	});
});
