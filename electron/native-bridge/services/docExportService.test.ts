import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DocExportService } from "./docExportService";
import { OpenAiKeyStore } from "./openAiKeyStore";

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
	decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
};

async function keyStoreWithKey() {
	const dir = await mkdtemp(path.join(tmpdir(), "doc-key-"));
	const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
	await store.setKey("sk-test");
	return store;
}

const steps = [
	{ id: "step-1", transcriptText: "Open the board.", imageDataUrl: "data:image/png;base64,AAA" },
];

const goodCompletion = {
	choices: [
		{
			message: {
				content: JSON.stringify({
					title: "T",
					overview: "O",
					audience: ["a"],
					learn: ["l"],
					steps: [{ id: "step-1", heading: "H", body: "B" }],
				}),
			},
		},
	],
};

describe("DocExportService.generate", () => {
	it("returns no-key when no key is set", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "doc-key-"));
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		const svc = new DocExportService({ keyStore: store, fetchImpl: vi.fn() });
		const res = await svc.generate(steps, { transcript: "…" });
		expect(res.code).toBe("no-key");
	});

	it("sends a multimodal request (image + text) and returns the parsed doc", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(goodCompletion), { status: 200 }),
		) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		const res = await svc.generate(steps, { transcript: "full transcript" });

		expect(res.success).toBe(true);
		expect(res.doc?.title).toBe("T");
		const body = JSON.parse(
			(fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1].body,
		);
		expect(body.model).toBe("gpt-4o-mini");
		const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
		const parts = userMsg.content as { type: string; image_url?: { url: string } }[];
		expect(
			parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image")),
		).toBe(true);
		expect(parts.some((p) => p.type === "text")).toBe(true);
	});

	it("maps a non-2xx response to api-error", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("nope", { status: 429 }),
		) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		expect((await svc.generate(steps, { transcript: "x" })).code).toBe("api-error");
	});

	it("maps bad JSON to invalid-response", async () => {
		const bad = { choices: [{ message: { content: "not json" } }] };
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(bad), { status: 200 }),
		) as unknown as typeof fetch;
		const svc = new DocExportService({ keyStore: await keyStoreWithKey(), fetchImpl });
		expect((await svc.generate(steps, { transcript: "x" })).code).toBe("invalid-response");
	});
});

describe("DocExportService.save", () => {
	it("writes .html and .pdf to the chosen path", async () => {
		const outDir = await mkdtemp(path.join(tmpdir(), "doc-out-"));
		const target = path.join(outDir, "walkthrough.html");
		const svc = new DocExportService({
			keyStore: await keyStoreWithKey(),
			showSaveDialog: async () => ({ canceled: false, filePath: target }),
			renderPdf: async () => Buffer.from("%PDF-1.4 fake"),
		});
		const res = await svc.save("<html><body>hi</body></html>");
		expect(res.success).toBe(true);
		const files = await readdir(outDir);
		expect(files).toContain("walkthrough.html");
		expect(files).toContain("walkthrough.pdf");
		expect(await readFile(target, "utf8")).toContain("hi");
	});

	it("returns canceled when the dialog is dismissed", async () => {
		const svc = new DocExportService({
			keyStore: await keyStoreWithKey(),
			showSaveDialog: async () => ({ canceled: true }),
			renderPdf: async () => Buffer.from(""),
		});
		expect((await svc.save("<html></html>")).canceled).toBe(true);
	});
});
