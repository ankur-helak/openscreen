import type { DeriveStepsInput, DocStep, NarrationSegment } from "./types";

const DEFAULT_COALESCE_MS = 1500;
const DEFAULT_MAX_STEPS = 20;

/** Merge ascending moments that fall within `windowMs` of the previous kept moment. */
function coalesce(moments: number[], windowMs: number): number[] {
	const out: number[] = [];
	for (const m of moments) {
		if (out.length === 0 || m - out[out.length - 1] >= windowMs) out.push(m);
	}
	return out;
}

function textForSpan(narration: NarrationSegment[], start: number, end: number): string {
	return narration
		.filter((s) => s.sourceEndMs > start && s.sourceStartMs < end)
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join(" ");
}

/**
 * Interaction-anchored step derivation: steps come from clicks + zoom/annotation moments,
 * coalesced so we don't get too many. Falls back to narration-segment starts when a recording
 * has no interactions. Each step spans [anchor, nextAnchor) and carries the narration in that span.
 */
export function deriveSteps(input: DeriveStepsInput): DocStep[] {
	const coalesceMs = input.coalesceMs ?? DEFAULT_COALESCE_MS;
	const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;

	let moments = [...input.clicks, ...input.zoomStarts, ...input.annotationStarts]
		.filter((m) => Number.isFinite(m) && m >= 0)
		.sort((a, b) => a - b);
	if (moments.length === 0) {
		moments = input.narration.map((s) => s.sourceStartMs).sort((a, b) => a - b);
	}
	if (moments.length === 0) return [];

	let windowMs = coalesceMs;
	let anchors = coalesce(moments, windowMs);
	while (anchors.length > maxSteps) {
		windowMs *= 2;
		const next = coalesce(moments, windowMs);
		if (next.length === anchors.length) break; // can't reduce further
		anchors = next;
	}
	if (anchors.length > maxSteps) {
		console.info(`[docExport] capping steps ${anchors.length} -> ${maxSteps}`);
		anchors = anchors.slice(0, maxSteps);
	}

	const steps: DocStep[] = [];
	for (let i = 0; i < anchors.length; i++) {
		const start = anchors[i];
		const end = i + 1 < anchors.length ? anchors[i + 1] : Math.max(input.endMs, start + 1);
		steps.push({
			id: `step-${i + 1}`,
			screenshotMs: start,
			spanStartMs: start,
			spanEndMs: end,
			transcriptText: textForSpan(input.narration, start, end),
		});
	}
	return steps;
}
