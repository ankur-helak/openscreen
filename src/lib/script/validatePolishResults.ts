import type { PolishSegmentResult } from "./types";

/**
 * Validate a polish response against the exact set of requested ids. On success returns
 * the results ordered by `requestedIds`. Throws if the response is not an array of
 * `{ id, text }` whose ids exactly match (no missing, extra, or duplicate ids) — this is
 * what guarantees the per-segment anchor/count invariant can never be violated.
 */
export function validatePolishResults(requestedIds: string[], raw: unknown): PolishSegmentResult[] {
	if (!Array.isArray(raw)) {
		throw new Error("Polish response was not an array of results.");
	}
	const byId = new Map<string, string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			throw new Error("Polish response contained a non-object entry.");
		}
		const { id, text } = item as { id?: unknown; text?: unknown };
		if (typeof id !== "string" || typeof text !== "string") {
			throw new Error("Polish response entry missing string id/text.");
		}
		if (byId.has(id)) {
			throw new Error(`Polish response contained duplicate id: ${id}`);
		}
		byId.set(id, text);
	}
	if (byId.size !== requestedIds.length) {
		throw new Error(
			`Polish response id count (${byId.size}) did not match requested (${requestedIds.length}).`,
		);
	}
	return requestedIds.map((id) => {
		const text = byId.get(id);
		if (text === undefined) {
			throw new Error(`Polish response missing requested id: ${id}`);
		}
		return { id, text };
	});
}
