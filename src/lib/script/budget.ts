/** Approx. spoken words per second (~150 wpm). Tunable. */
export const WORDS_PER_SECOND = 2.5;

/**
 * Soft word budget for a segment, derived from its original spoken span so the
 * rewritten line stays close to the original length (natural-with-drift timing).
 * Always ≥ 1 for any positive span.
 */
export function computeTargetWords(sourceStartMs: number, sourceEndMs: number): number {
	const seconds = (sourceEndMs - sourceStartMs) / 1000;
	if (!Number.isFinite(seconds) || seconds <= 0) return 1;
	return Math.max(1, Math.round(seconds * WORDS_PER_SECOND));
}
