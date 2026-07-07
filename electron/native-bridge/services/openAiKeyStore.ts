import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

const KEY_FILE = "openai-key.enc";

export type SafeStorageLike = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
};

export interface OpenAiKeyStoreOptions {
	/** Directory for the encrypted key (e.g. userData/openai). */
	configDir: string;
	/** Legacy directory to migrate a key from once (e.g. userData/script-polish). */
	legacyDir?: string;
	/** Injectable for tests; defaults to Electron safeStorage. */
	safeStorageImpl?: SafeStorageLike;
}

/**
 * Shared BYO OpenAI key, stored encrypted via Electron safeStorage in the main process.
 * Used by ScriptPolishService and DocExportService so both features share one key.
 */
export class OpenAiKeyStore {
	private readonly configDir: string;
	private readonly legacyDir?: string;
	private safeStorageImpl?: SafeStorageLike;
	private migrated = false;

	constructor(options: OpenAiKeyStoreOptions) {
		this.configDir = options.configDir;
		this.legacyDir = options.legacyDir;
		this.safeStorageImpl = options.safeStorageImpl;
	}

	private ss(): SafeStorageLike {
		this.safeStorageImpl ??= safeStorage;
		return this.safeStorageImpl;
	}

	private keyFile(): string {
		return path.join(this.configDir, KEY_FILE);
	}

	private async migrateIfNeeded(): Promise<void> {
		if (this.migrated || !this.legacyDir) return;
		this.migrated = true;
		const legacy = path.join(this.legacyDir, KEY_FILE);
		try {
			await access(this.keyFile());
			return; // new key already exists — nothing to migrate.
		} catch {
			// fall through
		}
		try {
			await access(legacy);
			await mkdir(this.configDir, { recursive: true });
			await copyFile(legacy, this.keyFile());
		} catch {
			// no legacy key — nothing to do.
		}
	}

	async readKey(): Promise<string | null> {
		await this.migrateIfNeeded();
		try {
			const buf = await readFile(this.keyFile());
			return this.ss().decryptString(buf);
		} catch {
			return null;
		}
	}

	async getKeyStatus(): Promise<{ hasKey: boolean }> {
		return { hasKey: (await this.readKey()) !== null };
	}

	async setKey(key: string): Promise<{ success: boolean; message?: string }> {
		try {
			const trimmed = key.trim();
			if (!trimmed) return { success: false, message: "Empty key." };
			if (!this.ss().isEncryptionAvailable()) {
				return { success: false, message: "Secure storage unavailable on this system." };
			}
			await mkdir(this.configDir, { recursive: true });
			await writeFile(this.keyFile(), this.ss().encryptString(trimmed));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async clearKey(): Promise<{ success: boolean; message?: string }> {
		try {
			await rm(this.keyFile(), { force: true });
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
