import { describe, expect, it } from "vitest";
import { validateGeneratedDoc } from "./validateDoc";

const good = {
	title: "Creating a New Ticket in Jira",
	overview: "This guide explains how to create a ticket.",
	audience: ["New users", "PMs"],
	learn: ["How to open the board", "How to create a ticket"],
	steps: [
		{ id: "step-2", heading: "Create", body: "Click **Create**." },
		{ id: "step-1", heading: "Board", body: "Open the board." },
	],
};

describe("validateGeneratedDoc", () => {
	it("accepts a valid doc and reorders steps by requestedIds", () => {
		const doc = validateGeneratedDoc(["step-1", "step-2"], good);
		expect(doc.steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
		expect(doc.title).toBe(good.title);
	});

	it("throws on a missing required field", () => {
		expect(() => validateGeneratedDoc(["step-1", "step-2"], { ...good, overview: "" })).toThrow();
	});

	it("throws on an id-set mismatch (extra id)", () => {
		const extra = { ...good, steps: [...good.steps, { id: "step-3", heading: "x", body: "y" }] };
		expect(() => validateGeneratedDoc(["step-1", "step-2"], extra)).toThrow();
	});

	it("throws on a duplicate id", () => {
		const dup = {
			...good,
			steps: [
				{ id: "step-1", heading: "a", body: "b" },
				{ id: "step-1", heading: "c", body: "d" },
			],
		};
		expect(() => validateGeneratedDoc(["step-1", "step-2"], dup)).toThrow();
	});

	it("throws on non-string audience entries", () => {
		expect(() =>
			validateGeneratedDoc(["step-1", "step-2"], { ...good, audience: [1, 2] }),
		).toThrow();
	});
});
