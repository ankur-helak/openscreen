import { describe, expect, it } from "vitest";
import { DEFAULT_TONE_ID, resolveToneInstruction, TONE_PRESETS } from "./tonePresets";

describe("tone presets", () => {
	it("includes the default preset id", () => {
		expect(TONE_PRESETS.some((p) => p.id === DEFAULT_TONE_ID)).toBe(true);
	});
	it("resolves a known id to its instruction", () => {
		const preset = TONE_PRESETS[0];
		expect(resolveToneInstruction(preset.id)).toBe(preset.instruction);
	});
	it("falls back to the default preset instruction for unknown/undefined", () => {
		const def = TONE_PRESETS.find((p) => p.id === DEFAULT_TONE_ID);
		expect(resolveToneInstruction(undefined)).toBe(def?.instruction);
		expect(resolveToneInstruction("does-not-exist")).toBe(def?.instruction);
	});
});
