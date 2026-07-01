/** Where the caption overlays shown on load should come from. */
export type CaptionSource = "project" | "draft" | "none";

export interface TranscriptLoadPlan {
	/** Which caption overlays to restore on load (transcript is handled separately). */
	captionSource: CaptionSource;
	/** Whether a transcript must be generated (no usable cache present). */
	needsTranscription: boolean;
}

/**
 * Pure decision for what to do when a video loads. Captions and the transcript are independent:
 * captions restore from project → draft → none; the transcript is always ensured, generating only
 * when nothing is cached.
 */
export function resolveTranscriptLoadPlan(inputs: {
	hasProjectCaptions: boolean;
	hasCaptionDraft: boolean;
	hasCachedTranscript: boolean;
}): TranscriptLoadPlan {
	const captionSource: CaptionSource = inputs.hasProjectCaptions
		? "project"
		: inputs.hasCaptionDraft
			? "draft"
			: "none";
	return { captionSource, needsTranscription: !inputs.hasCachedTranscript };
}
