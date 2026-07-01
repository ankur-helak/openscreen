import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import type { VoiceoverSegment } from "./types";

/** A synthesized clip placed on the OUTPUT (edited) timeline, for preview/export (Plan 4). */
export interface PlacedClip {
	segmentId: string;
	audioKey: string;
	startMs: number;
	durationMs: number;
}

/** The subset of a resolved clip that layout needs, keyed by segment id by the caller. */
export interface LayoutClipInput {
	audioKey: string;
	durationMs: number;
}

const DEFAULT_GAP_MS = 40;

/** True when a source-time anchor falls inside a removed (trimmed) region. Start-inclusive, end-exclusive. */
export function isAnchorTrimmed(sourceMs: number, trims: TrimRegion[]): boolean {
	return trims.some((tr) => sourceMs >= tr.startMs && sourceMs < tr.endMs);
}

/**
 * Map a source-time position to output (edited) time: subtract removed trim spans that end
 * before it (mirrors `computeTrimOffset` in audioEncoder.ts) and the time saved by sped-up
 * regions that lie before it. Clips play at natural length, so only the START is mapped.
 */
export function mapSourceToOutputMs(
	sourceMs: number,
	trims: TrimRegion[],
	speedRegions: SpeedRegion[],
): number {
	let out = sourceMs;
	for (const tr of trims) {
		if (tr.endMs <= sourceMs) {
			out -= tr.endMs - tr.startMs;
		} else if (tr.startMs < sourceMs) {
			// Anchor inside a trim: callers drop these, but stay safe by clamping to the trim start.
			out -= sourceMs - tr.startMs;
		}
	}
	for (const sp of speedRegions) {
		if (sp.speed <= 0) continue;
		const elapsedInRegion = Math.min(sourceMs, sp.endMs) - sp.startMs;
		if (elapsedInRegion <= 0) continue;
		out -= elapsedInRegion * (1 - 1 / sp.speed);
	}
	return Math.max(0, Math.round(out));
}

/**
 * Pure alignment used by preview + export so they can never disagree. For each ready segment:
 * skip if no clip; drop if its anchor is trimmed; else map the anchor to output time. Then
 * resolve overlaps by nudging each clip right to `prevEnd + gap` in output-time order.
 */
export function layoutVoiceover(input: {
	segments: VoiceoverSegment[];
	clipsById: Record<string, LayoutClipInput>;
	trims: TrimRegion[];
	speedRegions: SpeedRegion[];
	gapMs?: number;
}): PlacedClip[] {
	const gap = input.gapMs ?? DEFAULT_GAP_MS;
	const placed: PlacedClip[] = [];
	for (const seg of input.segments) {
		const clip = input.clipsById[seg.id];
		if (!clip) continue;
		if (isAnchorTrimmed(seg.sourceStartMs, input.trims)) continue;
		placed.push({
			segmentId: seg.id,
			audioKey: clip.audioKey,
			startMs: mapSourceToOutputMs(seg.sourceStartMs, input.trims, input.speedRegions),
			durationMs: clip.durationMs,
		});
	}
	placed.sort((a, b) => a.startMs - b.startMs);
	let prevEnd = Number.NEGATIVE_INFINITY;
	for (const p of placed) {
		if (p.startMs < prevEnd + gap) p.startMs = prevEnd + gap;
		prevEnd = p.startMs + p.durationMs;
	}
	return placed;
}
