import { describe, expect, it } from "vitest";
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES } from "./voices";

describe("KOKORO_VOICES", () => {
	it("has unique, non-empty voice ids", () => {
		const ids = KOKORO_VOICES.map((v) => v.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		for (const v of KOKORO_VOICES) {
			expect(v.id).toMatch(/^[a-z]{2}_[a-z]+$/);
			expect(v.label.length).toBeGreaterThan(0);
			expect(v.lang).toMatch(/^en-(US|GB)$/);
		}
	});

	it("includes the default voice", () => {
		expect(KOKORO_VOICES.some((v) => v.id === DEFAULT_KOKORO_VOICE)).toBe(true);
	});
});
