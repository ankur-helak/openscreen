import { describe, expect, it } from "vitest";
import { getKokoroProvider } from "./kokoroProvider";

describe("KokoroProvider (browser, real model)", () => {
	it("synthesizes non-empty 24kHz mono PCM from text", async () => {
		const provider = getKokoroProvider();
		try {
			const phases: string[] = [];
			const result = await provider.synthesize("Hello from OpenScreen.", {
				voice: "af_heart",
				speed: 1,
				onStatus: (p) => phases.push(p),
			});
			expect(result.sampleRate).toBe(24000);
			expect(result.pcm.length).toBeGreaterThan(24000 * 0.3); // > ~0.3s of audio
			// PCM must contain real signal, not silence.
			const peak = result.pcm.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
			expect(peak).toBeGreaterThan(0.01);
			expect(phases).toContain("model");
			expect(phases).toContain("synthesize");
		} finally {
			provider.dispose();
		}
	}, 120_000);
});
