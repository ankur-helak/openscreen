import type {
	AnnotationPosition,
	AnnotationRegion,
	AnnotationSize,
	AnnotationTextStyle,
} from "@/components/video-editor/types";
import { splitMergedCaptionsByWordBounds } from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import type { SegmentSynthStatus, VoiceoverSegment } from "./types";

export interface CaptionsFromScriptInput {
	segments: VoiceoverSegment[];
	statuses: Record<string, SegmentSynthStatus>;
	minWords: number;
	maxWords: number;
	style: AnnotationTextStyle;
	position: AnnotationPosition;
	size: AnnotationSize;
}

/** Guard so a clamped caption ends just before the next segment's source anchor. */
const OVERLAP_GUARD_MS = 1;

/**
 * Derives on-screen caption regions from the voiceover script. Captions are authored in
 * SOURCE time (the base the annotation renderers read): anchored at each ready segment's
 * `sourceStartMs`, with length = its TTS clip duration, clamped to not overlap the next
 * segment. Words are chunked by the existing caption word-bounds splitter. Ungenerated
 * segments produce no caption.
 */
export function captionRegionsFromScript(input: CaptionsFromScriptInput): AnnotationRegion[] {
	const { segments, statuses, minWords, maxWords, style, position, size } = input;

	const ready = segments
		.filter((s) => statuses[s.id]?.state === "ready")
		.sort((a, b) => a.sourceStartMs - b.sourceStartMs);

	const merged: CaptionSegment[] = [];
	for (let i = 0; i < ready.length; i++) {
		const seg = ready[i]!;
		const status = statuses[seg.id]!;
		if (status.state !== "ready") continue; // narrows the union to read durationMs
		const startMs = seg.sourceStartMs;
		let endMs = seg.sourceStartMs + status.durationMs;
		const next = ready[i + 1];
		if (next && endMs > next.sourceStartMs - OVERLAP_GUARD_MS) {
			endMs = next.sourceStartMs - OVERLAP_GUARD_MS;
		}
		const text = seg.text.trim();
		if (!text || endMs <= startMs) continue;
		merged.push({ startSec: startMs / 1000, endSec: endMs / 1000, text });
	}

	const lines = splitMergedCaptionsByWordBounds(merged, minWords, maxWords);

	return lines.map((line, index) => {
		const startMs = Math.round(line.startSec * 1000);
		const endMs = Math.max(Math.round(line.endSec * 1000), startMs + 1);
		return {
			id: `vo-caption-${index}`,
			startMs,
			endMs,
			type: "text",
			content: line.text,
			textContent: line.text,
			position: { ...position },
			size: { ...size },
			style: { ...style },
			zIndex: 0,
			annotationSource: "auto-caption",
		};
	});
}
