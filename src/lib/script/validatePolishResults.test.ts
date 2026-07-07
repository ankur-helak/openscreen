import { describe, expect, it } from "vitest";
import { validatePolishResults } from "./validatePolishResults";

const ids = ["vo-1", "vo-2"];

describe("validatePolishResults", () => {
	it("returns results ordered by requestedIds on an exact match", () => {
		const out = validatePolishResults(ids, [
			{ id: "vo-2", text: "second" },
			{ id: "vo-1", text: "first" },
		]);
		expect(out).toEqual([
			{ id: "vo-1", text: "first" },
			{ id: "vo-2", text: "second" },
		]);
	});
	it("throws on a missing id", () => {
		expect(() => validatePolishResults(ids, [{ id: "vo-1", text: "x" }])).toThrow();
	});
	it("throws on an extra id", () => {
		expect(() =>
			validatePolishResults(ids, [
				{ id: "vo-1", text: "x" },
				{ id: "vo-2", text: "y" },
				{ id: "vo-3", text: "z" },
			]),
		).toThrow();
	});
	it("throws on a duplicate id", () => {
		expect(() =>
			validatePolishResults(ids, [
				{ id: "vo-1", text: "x" },
				{ id: "vo-1", text: "y" },
			]),
		).toThrow();
	});
	it("throws when a text is missing or not a string", () => {
		expect(() => validatePolishResults(ids, [{ id: "vo-1", text: "x" }, { id: "vo-2" }])).toThrow();
	});
	it("throws when raw is not an array", () => {
		expect(() => validatePolishResults(ids, { nope: true })).toThrow();
	});
});
