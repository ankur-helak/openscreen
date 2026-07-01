import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipAudition } from "./useClipAudition";

class FakeBufferSource {
	buffer: unknown = null;
	onended: (() => void) | null = null;
	connect = vi.fn();
	start = vi.fn();
	stop = vi.fn(() => {
		this.onended?.();
	});
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	destination = {};
	closed = false;
	created: FakeBufferSource[] = [];
	// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op async mock
	resume = vi.fn(async () => {});
	constructor() {
		FakeAudioContext.instances.push(this);
	}
	createBuffer(_channels: number, length: number, sampleRate: number) {
		return { length, sampleRate, getChannelData: () => new Float32Array(length) };
	}
	createBufferSource() {
		const s = new FakeBufferSource();
		this.created.push(s);
		return s as unknown as AudioBufferSourceNode;
	}
	close = vi.fn(async () => {
		this.closed = true;
	});
}

beforeEach(() => {
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useClipAudition", () => {
	it("plays a clip and exposes its key while playing", async () => {
		const { result } = renderHook(() => useClipAudition());
		expect(result.current.auditioningKey).toBeNull();
		await act(async () => {
			result.current.play({ pcm: new Float32Array([0.1, 0.2, 0.3]), sampleRate: 24000 }, "k1");
			await Promise.resolve();
		});
		expect(result.current.auditioningKey).toBe("k1");
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.created[0].start).toHaveBeenCalled();
	});

	it("stop() halts playback and clears the key", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		act(() => {
			result.current.stop();
		});
		expect(result.current.auditioningKey).toBeNull();
	});

	it("playing a second clip replaces the first", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		act(() => {
			result.current.play({ pcm: new Float32Array([0.2]), sampleRate: 24000 }, "k2");
		});
		expect(result.current.auditioningKey).toBe("k2");
	});

	it("resumes a suspended context before starting playback", async () => {
		const { result } = renderHook(() => useClipAudition());
		await act(async () => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
			await Promise.resolve();
		});
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.resume).toHaveBeenCalled();
		expect(ctx.created[0].start).toHaveBeenCalled();
	});

	it("stops the previous source when a second clip replaces it", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const first = FakeAudioContext.instances[0].created[0];
		act(() => {
			result.current.play({ pcm: new Float32Array([0.2]), sampleRate: 24000 }, "k2");
		});
		expect(first.stop).toHaveBeenCalled();
	});

	it("clears the key when a clip ends naturally", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const source = FakeAudioContext.instances[0].created[0];
		act(() => {
			source.onended?.();
		});
		expect(result.current.auditioningKey).toBeNull();
	});

	it("closes the AudioContext on unmount", () => {
		const { result, unmount } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		const ctx = FakeAudioContext.instances[0];
		unmount();
		expect(ctx.close).toHaveBeenCalled();
	});
});
