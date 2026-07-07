import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptPolishService } from "./scriptPolishService";

// Fake safeStorage: reversible base64 "encryption" so we exercise the file round-trip.
const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8"),
	decryptString: (b: Buffer) => b.toString("utf8"),
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "sp-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeService(fetchImpl?: typeof fetch) {
	return new ScriptPolishService({ configDir: dir, fetchImpl, safeStorageImpl: fakeSafeStorage });
}

describe("ScriptPolishService key management", () => {
	it("reports no key initially, then set, then cleared", async () => {
		const svc = makeService();
		expect((await svc.getKeyStatus()).hasKey).toBe(false);
		await svc.setKey("sk-test");
		expect((await svc.getKeyStatus()).hasKey).toBe(true);
		await svc.clearKey();
		expect((await svc.getKeyStatus()).hasKey).toBe(false);
	});
});

describe("ScriptPolishService.polish", () => {
	it("returns code 'no-key' when no key is set", async () => {
		const svc = makeService();
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 5 }], "be concise");
		expect(res.success).toBe(false);
		expect(res.code).toBe("no-key");
	});

	it("sends the key + segments and returns parsed results", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({ results: [{ id: "vo-1", text: "Polished." }] }),
								},
							},
						],
					}),
					{ status: 200 },
				),
		) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "uh hello", targetWords: 3 }], "be concise");
		expect(res.success).toBe(true);
		expect(res.results).toEqual([{ id: "vo-1", text: "Polished." }]);
		const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
		const body = String((init as RequestInit).body);
		expect(body).toContain("vo-1");
		const payload = JSON.parse(body);
		expect(payload.messages[0].content).toContain("be concise");
		expect(payload.messages[1].content).toContain('"id":"vo-1"');
		expect(payload.messages[1].content).toContain('"text":"uh hello"');
		expect(payload.messages[1].content).toContain('"targetWords":3');
		const segments = JSON.parse(payload.messages[1].content).segments;
		expect(segments[0]).toEqual({ id: "vo-1", text: "uh hello", targetWords: 3 });
		expect(segments[0]).not.toHaveProperty("audio");
		expect(segments[0]).not.toHaveProperty("video");
	});

	it("returns code 'api-error' on a non-200 response", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("nope", { status: 429 }),
		) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 3 }], "x");
		expect(res.success).toBe(false);
		expect(res.code).toBe("api-error");
	});

	it("returns code 'api-error' on fetch timeout/abort", async () => {
		const fetchImpl = vi.fn(async () => {
			const err = new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		}) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 3 }], "x");
		expect(res.success).toBe(false);
		expect(res.code).toBe("api-error");
	});

	it("returns code 'invalid-response' when completion is not valid JSON", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "not json at all" } }],
					}),
					{ status: 200 },
				),
		) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 3 }], "x");
		expect(res.success).toBe(false);
		expect(res.code).toBe("invalid-response");
	});

	it("returns code 'invalid-response' when completion has no results array", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify({ wrongKey: [] }) } }],
					}),
					{ status: 200 },
				),
		) as unknown as typeof fetch;
		const svc = makeService(fetchImpl);
		await svc.setKey("sk-test");
		const res = await svc.polish([{ id: "vo-1", text: "hi", targetWords: 3 }], "x");
		expect(res.success).toBe(false);
		expect(res.code).toBe("invalid-response");
	});
});
