import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedClip } from "@/lib/voiceover/layout";
import { useVoiceoverPlayback } from "./useVoiceoverPlayback";

class FakeBufferSource {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	connect = vi.fn();
	start = vi.fn();
	stop = vi.fn();
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	currentTime = 0;
	destination = {};
	created: FakeBufferSource[] = [];
	// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op async mock
	resume = vi.fn(async () => {});
	// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op async mock
	close = vi.fn(async () => {});
	constructor() {
		FakeAudioContext.instances.push(this);
	}
	createBuffer(_channels: number, length: number, sampleRate: number) {
		return {
			length,
			sampleRate,
			duration: length / sampleRate,
			getChannelData: () => new Float32Array(length),
		};
	}
	createBufferSource() {
		const s = new FakeBufferSource();
		this.created.push(s);
		return s as unknown as AudioBufferSourceNode;
	}
}

function fakeVideo(currentTimeSec: number) {
	return { currentTime: currentTimeSec } as unknown as HTMLVideoElement;
}

const clips: PlacedClip[] = [{ segmentId: "vo-1", audioKey: "k1", startMs: 0, durationMs: 2000 }];
const clipPcmByKey = { k1: { pcm: new Float32Array(48000).fill(0.2), sampleRate: 24000 } };

function baseParams(over: Partial<Parameters<typeof useVoiceoverPlayback>[0]> = {}) {
	return {
		video: fakeVideo(0),
		enabled: true,
		isPlaying: false,
		isScrubbing: false,
		placedClips: clips,
		clipPcmByKey,
		trims: [],
		speedRegions: [],
		...over,
	};
}

beforeEach(() => {
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("useVoiceoverPlayback", () => {
	it("starts a source at the mapped offset when playing", async () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), { initialProps: baseParams() });
		await act(async () => {
			rerender(baseParams({ video: fakeVideo(0.5), isPlaying: true }));
			await Promise.resolve(); // flush microtasks so startSource's .finally() runs
		});
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.resume).toHaveBeenCalled();
		expect(ctx.created.at(-1)?.start).toHaveBeenCalled();
		// started with offset ≈ 0.5s (second start arg)
		const call = ctx.created.at(-1)?.start.mock.calls.at(-1);
		expect(call?.[1]).toBeCloseTo(0.5, 2);
	});

	it("stops playback on pause", () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ isPlaying: true }),
		});
		const started = FakeAudioContext.instances[0].created.at(-1);
		act(() => {
			rerender(baseParams({ isPlaying: false }));
		});
		expect(started?.stop).toHaveBeenCalled();
	});

	it("stays silent while scrubbing", () => {
		const { rerender } = renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ isPlaying: true }),
		});
		const startedBefore = FakeAudioContext.instances[0].created.length;
		act(() => {
			rerender(baseParams({ isPlaying: true, isScrubbing: true }));
		});
		const src = FakeAudioContext.instances[0].created.at(startedBefore - 1);
		expect(src?.stop).toHaveBeenCalled();
	});

	it("does not create a context when disabled", () => {
		renderHook((p) => useVoiceoverPlayback(p), {
			initialProps: baseParams({ enabled: false, isPlaying: true }),
		});
		expect(FakeAudioContext.instances.length).toBe(0);
	});

	it("re-syncs when drift exceeds the threshold", () => {
		vi.useFakeTimers();
		const video = fakeVideo(0);
		const params = baseParams({ video, isPlaying: true });
		renderHook((p) => useVoiceoverPlayback(p), { initialProps: params });
		const ctx = FakeAudioContext.instances[0];
		const firstSourceCount = ctx.created.length;
		// Advance the audio clock far past the video clock → large positive drift.
		ctx.currentTime = 2; // buffer thinks we're 2s in…
		(video as { currentTime: number }).currentTime = 0.5; // …but video is only 0.5s in.
		act(() => {
			vi.advanceTimersByTime(600); // one re-sync tick (interval 500ms)
		});
		expect(ctx.created.length).toBeGreaterThan(firstSourceCount); // a corrected source was created
	});
});
