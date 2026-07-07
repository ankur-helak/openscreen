import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ScriptPolishKeyResult,
	ScriptPolishKeyStatus,
	ScriptPolishResult,
} from "../../../src/native/contracts";

/** Hard-coded v1 model (see plan Global Constraints). */
const SCRIPT_POLISH_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const KEY_FILE = "openai-key.enc";

type SafeStorageLike = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
};

interface ScriptPolishServiceOptions {
	/** Directory for the encrypted key file (e.g. userData/script-polish). */
	configDir: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; defaults to Electron safeStorage (lazy-required). */
	safeStorageImpl?: SafeStorageLike;
}

/**
 * Runs the OpenAI script-polish call in the main process and owns the BYO API key,
 * stored encrypted via Electron safeStorage. The renderer never receives the key —
 * only `hasKey`. v1 sends segment TEXT only.
 */
export class ScriptPolishService {
	private readonly configDir: string;
	private readonly fetchImpl: typeof fetch;
	private safeStorageImpl?: SafeStorageLike;

	constructor(options: ScriptPolishServiceOptions) {
		this.configDir = options.configDir;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.safeStorageImpl = options.safeStorageImpl;
	}

	private safeStorage(): SafeStorageLike {
		if (!this.safeStorageImpl) {
			// Lazy require so tests never touch Electron.
			this.safeStorageImpl = require("electron").safeStorage as SafeStorageLike;
		}
		return this.safeStorageImpl;
	}

	private keyFile(): string {
		return path.join(this.configDir, KEY_FILE);
	}

	private async readKey(): Promise<string | null> {
		try {
			const buf = await readFile(this.keyFile());
			return this.safeStorage().decryptString(buf);
		} catch {
			return null;
		}
	}

	async getKeyStatus(): Promise<ScriptPolishKeyStatus> {
		return { hasKey: (await this.readKey()) !== null };
	}

	async setKey(key: string): Promise<ScriptPolishKeyResult> {
		try {
			const trimmed = key.trim();
			if (!trimmed) return { success: false, message: "Empty key." };
			if (!this.safeStorage().isEncryptionAvailable()) {
				return { success: false, message: "Secure storage unavailable on this system." };
			}
			await mkdir(this.configDir, { recursive: true });
			await writeFile(this.keyFile(), this.safeStorage().encryptString(trimmed));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearKey(): Promise<ScriptPolishKeyResult> {
		try {
			await rm(this.keyFile(), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async polish(
		segments: { id: string; text: string; targetWords: number }[],
		toneInstruction: string,
	): Promise<ScriptPolishResult> {
		const key = await this.readKey();
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
