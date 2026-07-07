import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocExportResult, DocExportSaveResult } from "../../../src/native/contracts";
import type { OpenAiKeyStore } from "./openAiKeyStore";

const DOC_EXPORT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

type SaveDialogFn = (options: {
	title?: string;
	defaultPath?: string;
	filters?: { name: string; extensions: string[] }[];
}) => Promise<{ canceled: boolean; filePath?: string }>;

type RenderPdfFn = (html: string) => Promise<Buffer>;

interface DocExportServiceOptions {
	keyStore: OpenAiKeyStore;
	fetchImpl?: typeof fetch;
	showSaveDialog?: SaveDialogFn;
	renderPdf?: RenderPdfFn;
}

/** Default PDF renderer: offscreen window → printToPDF (main-process only). */
async function defaultRenderPdf(html: string): Promise<Buffer> {
	const { BrowserWindow } = await import("electron");
	const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
	const tmp = path.join(tmpdir(), `docexport-${Date.now()}-${process.pid}.html`);
	try {
		await writeFile(tmp, html, "utf8");
		await win.loadFile(tmp);
		return await win.webContents.printToPDF({ printBackground: true });
	} finally {
		win.destroy();
		await rm(tmp, { force: true });
	}
}

async function defaultShowSaveDialog(options: Parameters<SaveDialogFn>[0]) {
	const { dialog } = await import("electron");
	return dialog.showSaveDialog(options);
}

/**
 * Main-process Doc Export: one multimodal OpenAI call (vision + transcript) to generate the
 * document, and file save (self-contained HTML + PDF). Reads the shared OpenAI key.
 */
export class DocExportService {
	private readonly keyStore: OpenAiKeyStore;
	private readonly fetchImpl: typeof fetch;
	private readonly showSaveDialog: SaveDialogFn;
	private readonly renderPdf: RenderPdfFn;

	constructor(options: DocExportServiceOptions) {
		this.keyStore = options.keyStore;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.showSaveDialog = options.showSaveDialog ?? defaultShowSaveDialog;
		this.renderPdf = options.renderPdf ?? defaultRenderPdf;
	}

	async generate(
		steps: { id: string; transcriptText: string; imageDataUrl: string }[],
		context: { transcript: string },
	): Promise<DocExportResult> {
		const key = await this.keyStore.readKey();
		if (!key) return { success: false, code: "no-key", message: "No OpenAI API key set." };

		const system = [
			"You write clear product-walkthrough documentation from a screen recording.",
			"You are given the full narration transcript and, per step, its narration plus a screenshot of the screen at that moment.",
			"Describe the page being looked at and the exact click-guide; bold the real on-screen UI elements the user interacts with using **double asterisks**.",
			'Return ONLY JSON of the form {"title":string,"overview":string,"audience":string[],"learn":string[],"steps":[{"id":string,"heading":string,"body":string}]}.',
			"Produce exactly one step object per provided step id — do not add, drop, merge, or rename ids.",
		].join(" ");

		const userContent: unknown[] = [
			{ type: "text", text: `Full transcript:\n${context.transcript}` },
		];
		for (const s of steps) {
			userContent.push({ type: "text", text: `Step id ${s.id}. Narration: ${s.transcriptText}` });
			userContent.push({ type: "image_url", image_url: { url: s.imageDataUrl, detail: "high" } });
		}

		let response: Response;
		try {
			response = await this.fetchImpl(OPENAI_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: DOC_EXPORT_MODEL,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: userContent },
					],
				}),
				signal: AbortSignal.timeout(120_000),
			});
		} catch (error) {
			return {
				success: false,
				code: "api-error",
				message: error instanceof Error ? error.message : String(error),
			};
		}

		if (!response.ok) {
			return {
				success: false,
				code: "api-error",
				message: `OpenAI request failed (${response.status}).`,
			};
		}

		try {
			const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
			const content = body.choices?.[0]?.message?.content;
			if (!content)
				return { success: false, code: "invalid-response", message: "Empty completion." };
			const doc = JSON.parse(content) as DocExportResult["doc"];
			if (!doc || typeof doc !== "object" || !Array.isArray(doc.steps)) {
				return { success: false, code: "invalid-response", message: "Malformed doc JSON." };
			}
			return { success: true, doc };
		} catch (error) {
			return {
				success: false,
				code: "invalid-response",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async save(html: string): Promise<DocExportSaveResult> {
		const chosen = await this.showSaveDialog({
			title: "Export walkthrough",
			defaultPath: "walkthrough.html",
			filters: [{ name: "HTML", extensions: ["html"] }],
		});
		if (chosen.canceled || !chosen.filePath) return { success: false, canceled: true };

		const htmlPath = chosen.filePath.endsWith(".html")
			? chosen.filePath
			: `${chosen.filePath}.html`;
		try {
			await writeFile(htmlPath, html, "utf8");
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
		try {
			const pdf = await this.renderPdf(html);
			await writeFile(htmlPath.replace(/\.html$/, ".pdf"), pdf);
		} catch (error) {
			// PDF is best-effort; the HTML already saved.
			console.warn("[DocExportService] PDF render failed:", error);
		}
		return { success: true, path: htmlPath };
	}
}
