import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OpenAiKeyStore } from "./openAiKeyStore";

// Fake safeStorage: base64 "encryption" so tests need no OS keychain.
const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
	decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
};

async function tmp(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "openai-key-"));
}

describe("OpenAiKeyStore", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await tmp();
	});

	it("round-trips set/status/clear", async () => {
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		expect((await store.getKeyStatus()).hasKey).toBe(false);
		expect((await store.setKey("sk-test")).success).toBe(true);
		expect((await store.getKeyStatus()).hasKey).toBe(true);
		expect(await store.readKey()).toBe("sk-test");
		expect((await store.clearKey()).success).toBe(true);
		expect((await store.getKeyStatus()).hasKey).toBe(false);
	});

	it("rejects an empty key", async () => {
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		expect((await store.setKey("   ")).success).toBe(false);
	});

	it("migrates a key from the legacy dir on first read", async () => {
		const legacyDir = await tmp();
		await writeFile(
			path.join(legacyDir, "openai-key.enc"),
			fakeSafeStorage.encryptString("sk-legacy") as unknown as Buffer,
		);
		const store = new OpenAiKeyStore({
			configDir: dir,
			legacyDir,
			safeStorageImpl: fakeSafeStorage,
		});
		expect(await store.readKey()).toBe("sk-legacy");
		// Migrated into the new location.
		const migrated = await readFile(path.join(dir, "openai-key.enc"));
		expect(fakeSafeStorage.decryptString(migrated)).toBe("sk-legacy");
	});
});
