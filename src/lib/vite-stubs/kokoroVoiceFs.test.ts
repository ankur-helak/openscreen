import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("kokoroVoiceFs shim", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exposes readFile only after a base URL is set", async () => {
		const mod = await import("./kokoroVoiceFs");
		expect(Object.hasOwn(mod.default, "readFile")).toBe(false);
		mod.setKokoroVoiceBaseUrl("https://example.test/voices/");
		expect(Object.hasOwn(mod.default, "readFile")).toBe(true);
		mod.setKokoroVoiceBaseUrl(null);
		expect(Object.hasOwn(mod.default, "readFile")).toBe(false);
	});

	it("readFile fetches <baseUrl>/<id>.bin and returns { buffer }", async () => {
		const bytes = new Float32Array([0.1, 0.2, 0.3]).buffer;
		const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
		vi.stubGlobal("fetch", fetchMock);

		const mod = await import("./kokoroVoiceFs");
		mod.setKokoroVoiceBaseUrl("https://example.test/models/Kokoro/voices/");
		// kokoro passes a path like "<dir>/../voices/af_heart.bin".
		const result = await mod.default.readFile?.("/anything/../voices/af_heart.bin");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.test/models/Kokoro/voices/af_heart.bin",
		);
		expect(result?.buffer).toBe(bytes);
	});

	it("readFile rejects when the path has no voice id", async () => {
		const mod = await import("./kokoroVoiceFs");
		mod.setKokoroVoiceBaseUrl("https://example.test/voices/");
		await expect(mod.default.readFile?.("/no/extension/here")).rejects.toThrow();
	});
});
