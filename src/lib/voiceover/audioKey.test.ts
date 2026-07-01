import { describe, expect, it } from "vitest";
import { computeAudioKey } from "./audioKey";

describe("computeAudioKey", () => {
	const base = { text: "Hello world.", voice: "af_heart", speed: 1 };

	it("is deterministic and hex", () => {
		const a = computeAudioKey(base);
		const b = computeAudioKey({ ...base });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]+$/);
	});

	it("changes when text, voice, or speed changes", () => {
		const key = computeAudioKey(base);
		expect(computeAudioKey({ ...base, text: "Hello world!" })).not.toBe(key);
		expect(computeAudioKey({ ...base, voice: "am_adam" })).not.toBe(key);
		expect(computeAudioKey({ ...base, speed: 1.1 })).not.toBe(key);
	});
});
