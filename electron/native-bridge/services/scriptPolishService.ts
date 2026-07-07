import type {
	ScriptPolishKeyResult,
	ScriptPolishKeyStatus,
	ScriptPolishResult,
} from "../../../src/native/contracts";
import type { OpenAiKeyStore } from "./openAiKeyStore";

/** Hard-coded v1 model (see plan Global Constraints). */
const SCRIPT_POLISH_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface ScriptPolishServiceOptions {
	/** Shared OpenAI key store. */
	keyStore: OpenAiKeyStore;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Runs the OpenAI script-polish call in the main process. The BYO key is owned by the
 * shared OpenAiKeyStore; the renderer never receives it — only `hasKey`. v1 sends text only.
 */
export class ScriptPolishService {
	private readonly keyStore: OpenAiKeyStore;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ScriptPolishServiceOptions) {
		this.keyStore = options.keyStore;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async getKeyStatus(): Promise<ScriptPolishKeyStatus> {
		return this.keyStore.getKeyStatus();
	}

	async setKey(key: string): Promise<ScriptPolishKeyResult> {
		return this.keyStore.setKey(key);
	}

	async clearKey(): Promise<ScriptPolishKeyResult> {
		return this.keyStore.clearKey();
	}

	async polish(
		segments: { id: string; text: string; targetWords: number }[],
		toneInstruction: string,
	): Promise<ScriptPolishResult> {
		const key = await this.keyStore.readKey();
		if (!key) return { success: false, code: "no-key", message: "No OpenAI API key set." };

		const system = [
			"You rewrite screen-recording narration segments.",
			toneInstruction,
			"Rewrite each segment to roughly its targetWords budget so its spoken length stays close to the original.",
			'Return ONLY JSON: {"results":[{"id":string,"text":string}]} with exactly one entry per input id. Do not merge, split, add, or drop segments.',
		].join(" ");
		const user = JSON.stringify({ segments });

		let response: Response;
		try {
			response = await this.fetchImpl(OPENAI_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: SCRIPT_POLISH_MODEL,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
				}),
				signal: AbortSignal.timeout(30_000),
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
			const body = (await response.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const content = body.choices?.[0]?.message?.content;
			if (!content)
				return { success: false, code: "invalid-response", message: "Empty completion." };
			const parsed = JSON.parse(content) as { results?: { id: string; text: string }[] };
			if (!Array.isArray(parsed.results)) {
				return {
					success: false,
					code: "invalid-response",
					message: "No results array in completion.",
				};
			}
			return { success: true, results: parsed.results };
		} catch (error) {
			return {
				success: false,
				code: "invalid-response",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
