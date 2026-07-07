import { describe, expect, it } from "vitest";
import { computeTargetWords, WORDS_PER_SECOND } from "./budget";

describe("computeTargetWords", () => {
	it("scales words by spoken duration at WORDS_PER_SECOND", () => {
		expect(computeTargetWords(0, 4000)).toBe(Math.round(4 * WORDS_PER_SECOND));
	});
	it("never returns below 1 for a non-empty span", () => {
		expect(computeTargetWords(0, 100)).toBeGreaterThanOrEqual(1);
	});
	it("returns 1 for a zero/negative span (defensive)", () => {
		expect(computeTargetWords(5000, 5000)).toBe(1);
		expect(computeTargetWords(5000, 4000)).toBe(1);
	});
});
