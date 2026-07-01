import type { CaptionSegment } from "@/lib/captioning";
import type { VoiceoverSegmentDraft } from "./types";

export interface SegmentationOptions {
	/** Start a new clip when the silence between segments exceeds this (ms). */
	silenceGapMs?: number;
	/** Never let a clip's spanned source duration exceed this (ms). */
	maxClipMs?: number;
}

export const DEFAULT_SEGMENTATION: Required<SegmentationOptions> = {
	silenceGapMs: 700,
	maxClipMs: 24_000,
};

function endsSentence(text: string): boolean {
	return /[.!?]["')\]]?\s*$/.test(text);
}

interface Accum {
	startMs: number;
	endMs: number;
	parts: string[];
}

/**
 * Groups transcript segments into sentence-sized voiceover clips. A new clip begins
 * when the current text already ended a sentence, when the inter-segment silence gap
 * exceeds `silenceGapMs`, or when appending would push the spanned duration past
 * `maxClipMs`. Blank segments are dropped; text is trimmed and single-space joined.
 */
export function segmentTranscript(
	segments: CaptionSegment[],
	opts: SegmentationOptions = {},
): VoiceoverSegmentDraft[] {
	const { silenceGapMs, maxClipMs } = { ...DEFAULT_SEGMENTATION, ...opts };
	const out: VoiceoverSegmentDraft[] = [];
	let cur: Accum | null = null;
	let prevEndMs = 0;

	const flush = () => {
		if (!cur) return;
		const text = cur.parts.join(" ").trim();
		if (text) out.push({ sourceStartMs: cur.startMs, sourceEndMs: cur.endMs, text });
		cur = null;
	};

	for (const s of segments) {
		const text = s.text.trim();
		if (!text) continue;
		const startMs = Math.round(s.startSec * 1000);
		const endMs = Math.round(s.endSec * 1000);

		if (cur) {
			const gap = startMs - prevEndMs;
			const wouldExceed = endMs - cur.startMs > maxClipMs;
			if (endsSentence(cur.parts[cur.parts.length - 1]) || gap > silenceGapMs || wouldExceed) {
				flush();
			}
		}

		if (!cur) {
			cur = { startMs, endMs, parts: [text] };
		} else {
			cur.parts.push(text);
			cur.endMs = endMs;
		}
		prevEndMs = endMs;
	}
	flush();
	return out;
}
