import type { DocExportGeneratedDoc } from "@/native/contracts";

/** The AI-generated document shape (single source of truth is the wire contract). */
export type GeneratedDoc = DocExportGeneratedDoc;
export type GeneratedDocStep = DocExportGeneratedDoc["steps"][number];

/** A narration span from the transcript (or voiceover script when present). */
export interface NarrationSegment {
	sourceStartMs: number;
	sourceEndMs: number;
	text: string;
}

/** A derived step: an interaction anchor + the narration overlapping its span. */
export interface DocStep {
	id: string; // "step-1", "step-2", …
	screenshotMs: number; // instant to capture the composited frame
	spanStartMs: number;
	spanEndMs: number;
	transcriptText: string;
}

/** Per-step payload sent to the model (text + image). */
export interface DocStepInput {
	id: string;
	transcriptText: string;
	imageDataUrl: string;
}

export interface DeriveStepsInput {
	/** Click sample times (ms), from cursor samples with interactionType === "click". */
	clicks: number[];
	/** Zoom region start times (ms). */
	zoomStarts: number[];
	/** Annotation region start times (ms), excluding auto-captions. */
	annotationStarts: number[];
	/** Narration segments (voiceover.segments if present, else segmented transcript). */
	narration: NarrationSegment[];
	/** Output end time (ms) — bounds the last step's span. */
	endMs: number;
	coalesceMs?: number;
	maxSteps?: number;
}
