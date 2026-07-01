import { describe, expect, it } from "vitest";
import type { PlacedClip } from "@/lib/voiceover/layout";
import { AudioProcessor, resampleMonoPcm } from "./audioEncoder";

// Minimal muxer stand-in that only needs addAudioChunk for this unit.
function fakeMuxer() {
	const chunks: EncodedAudioChunk[] = [];
	return {
		chunks,
		async addAudioChunk(chunk: EncodedAudioChunk) {
			chunks.push(chunk);
		},
	} as unknown as import("./muxer").VideoMuxer & { chunks: EncodedAudioChunk[] };
}

describe("resampleMonoPcm", () => {
	it("returns the same array when from and to rates match", async () => {
		const input = new Float32Array([0.1, 0.2, 0.3]);
		const out = await resampleMonoPcm(input, 24000, 24000);
		expect(out).toBe(input);
	});

	it("upsamples 24k → 48k to roughly double the length", async () => {
		const input = new Float32Array(2400).fill(0.25); // 0.1s @ 24k
		const out = await resampleMonoPcm(input, 24000, 48000);
		// ~0.1s @ 48k ≈ 4800 samples (allow small rounding slack).
		expect(out.length).toBeGreaterThan(4700);
		expect(out.length).toBeLessThan(4900);
	});
});

describe("AudioProcessor.synthesizeVoiceoverTrack", () => {
	it("encodes and muxes a stereo track for placed clips", async () => {
		const codec = await AudioProcessor.selectSupportedExportCodec(48000, 2);
		expect(codec).not.toBeNull();
		if (!codec) return;

		const pcm = new Float32Array(24000).fill(0.2); // 1s @ 24k mono
		const placedClips: PlacedClip[] = [
			{ segmentId: "vo-1", audioKey: "k1", startMs: 0, durationMs: 1000 },
			{ segmentId: "vo-2", audioKey: "k2", startMs: 2000, durationMs: 1000 },
		];
		const clipPcmByKey = {
			k1: { pcm, sampleRate: 24000 },
			k2: { pcm, sampleRate: 24000 },
		};
		const muxer = fakeMuxer();

		const processor = new AudioProcessor();
		await processor.synthesizeVoiceoverTrack(placedClips, clipPcmByKey, 3500, codec, muxer);

		expect(muxer.chunks.length).toBeGreaterThan(0);
	});

	it("produces no chunks when cancelled", async () => {
		const codec = await AudioProcessor.selectSupportedExportCodec(48000, 2);
		if (!codec) return;
		const muxer = fakeMuxer();
		const processor = new AudioProcessor();
		processor.cancel();
		await processor.synthesizeVoiceoverTrack([], {}, 1000, codec, muxer);
		expect(muxer.chunks.length).toBe(0);
	});
});
