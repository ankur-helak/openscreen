import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceoverService } from "./voiceoverService";

let root: string;
let service: VoiceoverService;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "vo-cache-"));
	service = new VoiceoverService({ cacheDir: path.join(root, "voiceovers") });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("VoiceoverService", () => {
	it("round-trips PCM + sample rate", async () => {
		const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const put = await service.putClip("abc123", pcm.buffer, 24000);
		expect(put.success).toBe(true);

		const got = await service.getClip("abc123");
		expect(got.success).toBe(true);
		expect(got.sampleRate).toBe(24000);
		// Check that pcm is present and can be converted to Float32Array
		expect(got.pcm).toBeDefined();
		const recovered = new Float32Array(got.pcm as ArrayBuffer);
		expect(Array.from(recovered)).toEqual(Array.from(pcm));
	});

	it("returns success with no pcm on a cache miss", async () => {
		const got = await service.getClip("missing");
		expect(got.success).toBe(true);
		expect(got.pcm).toBeUndefined();
	});
});
