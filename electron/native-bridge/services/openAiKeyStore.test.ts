import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

// Fake safeStorage that reports encryption UNAVAILABLE (e.g. keychain denied/locked).
const fakeSafeStorageUnavailable = {
	isEncryptionAvailable: () => false,
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

	it("clearKey permanently removes a migrated legacy key (no resurrection on a fresh store)", async () => {
		const legacyDir = await tmp();
		const configDir = await tmp();
		// Seed a legacy encrypted key.
		await writeFile(
			path.join(legacyDir, "openai-key.enc"),
			fakeSafeStorage.encryptString("sk-legacy") as unknown as Buffer,
		);
		// First store: migration happens on readKey.
		const store1 = new OpenAiKeyStore({ configDir, legacyDir, safeStorageImpl: fakeSafeStorage });
		expect(await store1.readKey()).toBe("sk-legacy");
		// User clears the key.
		expect((await store1.clearKey()).success).toBe(true);
		// Second store (fresh instance, simulating a relaunch): key must NOT resurrect.
		const store2 = new OpenAiKeyStore({ configDir, legacyDir, safeStorageImpl: fakeSafeStorage });
		expect(await store2.readKey()).toBeNull();
	});

	it("falls back to a session-only key when secure storage is unavailable", async () => {
		const store = new OpenAiKeyStore({
			configDir: dir,
			safeStorageImpl: fakeSafeStorageUnavailable,
		});
		const res = await store.setKey("sk-session");
		expect(res.success).toBe(true);
		expect(res.sessionOnly).toBe(true);
		expect(await store.readKey()).toBe("sk-session");

		const status = await store.getKeyStatus();
		expect(status).toEqual({ hasKey: true, secureStorageAvailable: false, sessionOnly: true });

		// Nothing was written to disk.
		const files = await readdir(dir);
		expect(files).not.toContain("openai-key.enc");
	});

	it("clearKey wipes a session-only key", async () => {
		const store = new OpenAiKeyStore({
			configDir: dir,
			safeStorageImpl: fakeSafeStorageUnavailable,
		});
		await store.setKey("sk-session");
		expect((await store.clearKey()).success).toBe(true);
		expect(await store.readKey()).toBeNull();
		expect((await store.getKeyStatus()).hasKey).toBe(false);
	});

	it("reports secureStorageAvailable and sessionOnly=false for a persisted key", async () => {
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: fakeSafeStorage });
		await store.setKey("sk-persist");
		expect(await store.getKeyStatus()).toEqual({
			hasKey: true,
			secureStorageAvailable: true,
			sessionOnly: false,
		});
	});

	it("prefers a session key over a persisted disk key", async () => {
		let available = true;
		const mutableFake = {
			isEncryptionAvailable: () => available,
			encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
			decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
		};
		const store = new OpenAiKeyStore({ configDir: dir, safeStorageImpl: mutableFake });
		await store.setKey("sk-disk"); // persisted while available
		available = false;
		const res = await store.setKey("sk-session"); // storage now unavailable → session
		expect(res.sessionOnly).toBe(true);
		expect(await store.readKey()).toBe("sk-session");
	});
});
