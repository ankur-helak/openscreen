import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptionDraftResult, TranscriptCacheResult } from "../../../src/native/contracts";

interface TranscriptServiceOptions {
	/** Directory for transcript cache files (e.g. userData/transcripts). */
	cacheDir: string;
	/** Directory for caption autosave drafts (e.g. userData/caption-drafts). */
	draftsDir: string;
	/** Normalizes a renderer-supplied source path (e.g. strips file:// ) to a real fs path. */
	resolveSourcePath: (sourcePath: string) => string | null;
}

/**
 * File-backed sidecar cache for generated transcripts, plus caption autosave drafts. Both are keyed
 * to the video by a cheap stat signature (path + size + mtime) so edits to the source invalidate
 * the cache without hashing the whole file.
 */
export class TranscriptService {
	constructor(private readonly options: TranscriptServiceOptions) {}

	private async keyFor(sourcePath: string): Promise<string> {
		const resolved = this.options.resolveSourcePath(sourcePath) ?? sourcePath;
		let signature = resolved;
		try {
			const s = await stat(resolved);
			signature = `${resolved}:${s.size}:${Math.round(s.mtimeMs)}`;
		} catch {
			// Unresolvable path — fall back to the raw string so behaviour is deterministic.
		}
		return createHash("sha1").update(signature).digest("hex");
	}

	private async readJson(dir: string, key: string): Promise<unknown | undefined> {
		try {
			const raw = await readFile(path.join(dir, `${key}.json`), "utf8");
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	private async writeJson(dir: string, key: string, value: unknown): Promise<void> {
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), "utf8");
	}

	async getTranscript(sourcePath: string): Promise<TranscriptCacheResult> {
		try {
			const key = await this.keyFor(sourcePath);
			const transcript = await this.readJson(this.options.cacheDir, key);
			return { success: true, transcript };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async putTranscript(sourcePath: string, transcript: unknown): Promise<TranscriptCacheResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await this.writeJson(this.options.cacheDir, key, transcript);
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async getCaptionDraft(sourcePath: string): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			const regions = await this.readJson(this.options.draftsDir, key);
			return { success: true, regions };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async putCaptionDraft(sourcePath: string, regions: unknown): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await this.writeJson(this.options.draftsDir, key, regions);
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearCaptionDraft(sourcePath: string): Promise<CaptionDraftResult> {
		try {
			const key = await this.keyFor(sourcePath);
			await rm(path.join(this.options.draftsDir, `${key}.json`), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
