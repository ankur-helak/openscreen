import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ID, getActiveProvider, listProviderIds } from "./config";

describe("transcription config", () => {
	it("defaults to the whisper-local provider", () => {
		const provider = getActiveProvider();
		expect(provider.id).toBe(DEFAULT_PROVIDER_ID);
		expect(provider.id).toBe("whisper-local");
		expect(provider.model).toBe("whisper-base.en");
	});

	it("resolves a provider by id", () => {
		expect(getActiveProvider("whisper-local").id).toBe("whisper-local");
	});

	it("throws on an unknown provider id", () => {
		expect(() => getActiveProvider("does-not-exist")).toThrow(/Unknown provider/);
	});

	it("lists the registered provider ids", () => {
		expect(listProviderIds()).toContain("whisper-local");
	});
});
