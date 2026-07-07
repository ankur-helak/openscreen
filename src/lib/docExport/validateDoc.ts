import type { GeneratedDoc } from "./types";

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate an AI doc response. Throws unless the doc has the required fields and its steps
 * contain exactly one entry per requested id (no missing/extra/duplicate). Returns steps
 * reordered by `requestedIds` — the all-or-nothing guarantee for the doc.
 */
export function validateGeneratedDoc(requestedIds: string[], raw: unknown): GeneratedDoc {
	if (!raw || typeof raw !== "object") throw new Error("Doc response was not an object.");
	const d = raw as Record<string, unknown>;
	if (!isNonEmptyString(d.title)) throw new Error("Doc missing title.");
	if (!isNonEmptyString(d.overview)) throw new Error("Doc missing overview.");
	if (!isStringArray(d.audience)) throw new Error("Doc audience must be a string array.");
	if (!isStringArray(d.learn)) throw new Error("Doc learn must be a string array.");
	if (!Array.isArray(d.steps)) throw new Error("Doc steps was not an array.");

	const byId = new Map<string, { heading: string; body: string }>();
	for (const item of d.steps) {
		if (!item || typeof item !== "object") throw new Error("Doc step was not an object.");
		const { id, heading, body } = item as { id?: unknown; heading?: unknown; body?: unknown };
		if (typeof id !== "string" || typeof heading !== "string" || typeof body !== "string") {
			throw new Error("Doc step missing string id/heading/body.");
		}
		if (byId.has(id)) throw new Error(`Doc step duplicate id: ${id}`);
		byId.set(id, { heading, body });
	}
	if (byId.size !== requestedIds.length) {
		throw new Error(
			`Doc step count (${byId.size}) did not match requested (${requestedIds.length}).`,
		);
	}
	const steps = requestedIds.map((id) => {
		const s = byId.get(id);
		if (!s) throw new Error(`Doc missing requested step id: ${id}`);
		return { id, heading: s.heading, body: s.body };
	});
	return { title: d.title, overview: d.overview, audience: d.audience, learn: d.learn, steps };
}
