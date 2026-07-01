import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake Worker that echoes a synthesized result for each posted request id.
class FakeWorker {
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	posted: unknown[] = [];
	terminated = false;
	postMessage(msg: { id: number; text: string }) {
		this.posted.push(msg);
		// Reply asynchronously, like a real worker.
		queueMicrotask(() => {
			this.onmessage?.({ data: { id: msg.id, type: "status", phase: "model" } } as MessageEvent);
			this.onmessage?.({
				data: { id: msg.id, type: "result", pcm: new Float32Array([0.1, 0.2]), sampleRate: 24000 },
			} as MessageEvent);
		});
	}
	terminate() {
		this.terminated = true;
	}
}

let fake: FakeWorker;

// The provider constructs `new Worker(new URL("./synthesize.worker.ts", import.meta.url), ...)`.
// Stub the global Worker so no real bundle/model loads in the jsdom unit tier.
beforeEach(() => {
	fake = new FakeWorker();
	vi.stubGlobal(
		"Worker",
		vi.fn(function () {
			return fake;
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("getKokoroProvider", () => {
	it("synthesizes and returns the worker's PCM result", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const provider = getKokoroProvider();
		const statuses: string[] = [];
		const result = await provider.synthesize("Hello world.", {
			voice: "af_heart",
			speed: 1,
			onStatus: (p) => statuses.push(p),
		});
		expect(Array.from(result.pcm)).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)]);
		expect(result.sampleRate).toBe(24000);
		expect(statuses).toContain("model");
		provider.dispose();
		expect(fake.terminated).toBe(true);
	});

	it("reuses one worker across multiple synthesize calls", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const provider = getKokoroProvider();
		await provider.synthesize("One.", { voice: "af_heart", speed: 1 });
		await provider.synthesize("Two.", { voice: "af_heart", speed: 1 });
		expect((globalThis.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
			1,
		);
		expect(fake.posted.length).toBe(2);
		provider.dispose();
	});

	it("lists the curated voices", async () => {
		const { getKokoroProvider } = await import("./kokoroProvider");
		const voices = await getKokoroProvider().listVoices();
		expect(voices.some((v) => v.id === "af_heart")).toBe(true);
	});
});
