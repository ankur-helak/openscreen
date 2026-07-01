import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcript } from "@/lib/transcription";
import type { TtsProvider } from "@/lib/tts/provider";
import { computeAudioKey } from "@/lib/voiceover/audioKey";
import { DEFAULT_VOICEOVER_CONFIG, type VoiceoverConfig } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";
import { useVoiceover } from "./useVoiceover";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		voiceover: {
			getClip: vi.fn(async () => ({ success: true })),
			putClip: vi.fn(async () => ({ success: true })),
		},
	},
}));

const fakeProvider = (): TtsProvider => ({
	id: "kokoro-local",
	listVoices: async () => [],
	synthesize: async () => ({ pcm: new Float32Array(24000), sampleRate: 24000 }),
	dispose: () => {
		// No-op for test
	},
});

const transcript: Transcript = {
	segments: [
		{ startSec: 0, endSec: 1, text: "Hello world." },
		{ startSec: 1, endSec: 2, text: "Second line." },
	],
	granularity: "phrase",
	provider: "whisper",
	model: "tiny",
	audioDurationSec: 2,
	truncated: false,
	createdAt: 0,
	schemaVersion: 1,
};

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("useVoiceover", () => {
	it("seedFromTranscript populates empty segments with vo- ids", () => {
		let config: VoiceoverConfig = { ...DEFAULT_VOICEOVER_CONFIG };
		const onChange = vi.fn((updater: (p: VoiceoverConfig) => VoiceoverConfig) => {
			config = updater(config);
		});
		const { result, rerender } = renderHook(
			(props: { config: VoiceoverConfig }) =>
				useVoiceover({ config: props.config, transcript, onChange, provider: fakeProvider() }),
			{ initialProps: { config } },
		);
		act(() => result.current.seedFromTranscript());
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(config.segments).toHaveLength(2);
		expect(config.segments[0].id).toBe("vo-1");
		expect(config.segments[0].text).toBe("Hello world.");
		rerender({ config });
	});

	it("generateSegment synthesizes, caches, and marks ready", async () => {
		const config: VoiceoverConfig = {
			...DEFAULT_VOICEOVER_CONFIG,
			segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 1000, text: "Hello world." }],
		};
		const { result } = renderHook(() =>
			useVoiceover({ config, transcript, onChange: vi.fn(), provider: fakeProvider() }),
		);
		await act(async () => {
			await result.current.generateSegment("vo-1");
		});
		const key = computeAudioKey({ text: "Hello world.", voice: config.voice, speed: config.speed });
		expect(nativeBridgeClient.voiceover.putClip).toHaveBeenCalledWith(
			key,
			expect.any(ArrayBuffer),
			24000,
		);
		expect(result.current.statuses["vo-1"]).toEqual({
			state: "ready",
			audioKey: key,
			durationMs: 1000,
		});
		expect(result.current.clips[key].durationMs).toBe(1000);
	});

	it("resolves a cache hit to ready without synthesizing", async () => {
		const pcm = new Float32Array(12000); // 0.5s @ 24kHz
		(nativeBridgeClient.voiceover.getClip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			success: true,
			pcm: pcm.buffer,
			sampleRate: 24000,
		});
		const config: VoiceoverConfig = {
			...DEFAULT_VOICEOVER_CONFIG,
			segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "Cached." }],
		};
		const provider = fakeProvider();
		const synthSpy = vi.spyOn(provider, "synthesize");
		const { result } = renderHook(() =>
			useVoiceover({ config, transcript, onChange: vi.fn(), provider }),
		);
		await waitFor(() => {
			expect(result.current.statuses["vo-1"]?.state).toBe("ready");
		});
		expect(synthSpy).not.toHaveBeenCalled();
	});

	it("generateSegment sends only the view's bytes to putClip (not the whole backing buffer)", async () => {
		const backing = new Float32Array(100); // 400-byte buffer
		const view = backing.subarray(10, 34); // 24 samples → 96 bytes, byteOffset 40
		const provider = fakeProvider();
		vi.spyOn(provider, "synthesize").mockResolvedValue({ pcm: view, sampleRate: 24000 });
		const config = {
			...DEFAULT_VOICEOVER_CONFIG,
			segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 1000, text: "Hi." }],
		};
		const { result } = renderHook(() =>
			useVoiceover({ config, transcript, onChange: vi.fn(), provider }),
		);
		await act(async () => {
			await result.current.generateSegment("vo-1");
		});
		const putArgs = (nativeBridgeClient.voiceover.putClip as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const sentBuffer = putArgs[1] as ArrayBuffer;
		expect(sentBuffer.byteLength).toBe(view.byteLength); // 96, NOT backing.buffer.byteLength (400)
		expect(Array.from(new Float32Array(sentBuffer))).toEqual(Array.from(view));
	});
});
