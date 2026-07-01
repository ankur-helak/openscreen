import { describe, expect, it } from "vitest";
import pathShim from "./kokoroPath";

describe("kokoroPath shim", () => {
	it("resolve joins args and preserves the voice basename", () => {
		const out = pathShim.resolve("/some/dir", "../voices/af_heart.bin");
		expect(out.endsWith("af_heart.bin")).toBe(true);
	});

	it("resolve tolerates an undefined dir (worker has no __dirname)", () => {
		const out = pathShim.resolve(undefined as unknown as string, "../voices/bm_george.bin");
		expect(out.endsWith("bm_george.bin")).toBe(true);
	});
});
