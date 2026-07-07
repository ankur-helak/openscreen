# Session-Only OpenAI Key Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When macOS `safeStorage` is unavailable, let the user still enter and use their OpenAI key for the current session (in memory only) instead of hitting a dead-end "Secure storage unavailable" error.

**Architecture:** The shared main-process `OpenAiKeyStore` gains an in-memory `sessionKey` fallback used when `safeStorage.isEncryptionAvailable()` is false. Its `getKeyStatus` now reports `{ hasKey, secureStorageAvailable, sessionOnly }` over the existing `scriptPolish` native-bridge channel; the renderer `OpenAiKeyDialog` uses those flags to show a proactive hint and a neutral post-save note. The key is never written to disk unencrypted.

**Tech Stack:** Electron main (`safeStorage`, relative imports), React + TypeScript renderer (`@/*` alias), Vitest (node + jsdom), `@testing-library/react` + `@testing-library/jest-dom`.

## Global Constraints

- Node **22.x** / npm **10.x**.
- `electron/` uses **relative imports**; `src/` uses the **`@/*`** alias only.
- TS: `interface` for object shapes, `type` for unions; **no `enum`**; avoid `any`.
- **Never persist the key to disk unencrypted.** The fallback is in-memory, session-scoped only.
- Production build drops `console.log`/`console.debug`; surviving logs use `console.warn/error/info`, tagged `[Component]`.
- Any user-facing string is added to **all 13 locales** (`ar, en, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW`); verify `npm run i18n:check` (the `docExport`/`voiceover` namespaces must stay in parity; the pre-existing `timeline.json` gaps are out of scope).
- Tests co-located (`foo.ts` → `foo.test.ts`).
- Pre-PR green: `npm run lint && npx tsc --noEmit && npm run test`. Husky runs lint-staged on commit; never `--no-verify`.

---

## Task 1: `OpenAiKeyStore` session fallback + widened key status (main)

**Files:**
- Modify: `src/native/contracts.ts` (widen `ScriptPolishKeyStatus`, `ScriptPolishKeyResult`)
- Modify: `electron/native-bridge/services/openAiKeyStore.ts`
- Test: `electron/native-bridge/services/openAiKeyStore.test.ts`

**Interfaces:**
- Produces:
  - `OpenAiKeyStore.setKey(key: string): Promise<{ success: boolean; message?: string; sessionOnly?: boolean }>`
  - `OpenAiKeyStore.readKey(): Promise<string | null>` (session key preferred, else persisted)
  - `OpenAiKeyStore.getKeyStatus(): Promise<{ hasKey: boolean; secureStorageAvailable: boolean; sessionOnly: boolean }>`
  - `OpenAiKeyStore.clearKey(): Promise<{ success: boolean; message?: string }>`
  - `ScriptPolishKeyStatus = { hasKey: boolean; secureStorageAvailable: boolean; sessionOnly: boolean }`
  - `ScriptPolishKeyResult = { success: boolean; message?: string; sessionOnly?: boolean }`
- Consumes: nothing new. `ScriptPolishService` already delegates to the store and annotates the contract return types — its shapes stay assignable, so it needs no edit.

- [ ] **Step 1: Widen the contracts**

In `src/native/contracts.ts`, replace the existing `ScriptPolishKeyStatus` and `ScriptPolishKeyResult` interfaces with:

```ts
export interface ScriptPolishKeyStatus {
	hasKey: boolean;
	/** Whether OS secure storage (macOS Keychain, etc.) is available for persisting the key. */
	secureStorageAvailable: boolean;
	/** True when a key is set but only held in memory for this session (not persisted). */
	sessionOnly: boolean;
}
export interface ScriptPolishKeyResult {
	success: boolean;
	message?: string;
	/** Set when the key was accepted but only kept for this session (secure storage unavailable). */
	sessionOnly?: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

In `electron/native-bridge/services/openAiKeyStore.test.ts`, add a second fake and new cases. Add this fake after the existing `fakeSafeStorage` (line ~12):

```ts
// Fake safeStorage that reports encryption UNAVAILABLE (e.g. keychain denied/locked).
const fakeSafeStorageUnavailable = {
	isEncryptionAvailable: () => false,
	encryptString: (s: string) => Buffer.from(s, "utf8").toString("base64") as unknown as Buffer,
	decryptString: (b: Buffer) => Buffer.from(String(b), "base64").toString("utf8"),
};
```

Add these cases inside the `describe("OpenAiKeyStore", …)` block (import `readdir` — update line 1 to `import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";`):

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run electron/native-bridge/services/openAiKeyStore.test.ts`
Expected: FAIL — `setKey` returns `{ success: false, message: "Secure storage unavailable…" }` (no `sessionOnly`), and `getKeyStatus` returns only `{ hasKey }`, so the `toEqual` / `sessionOnly` assertions fail.

- [ ] **Step 4: Implement the session fallback**

In `electron/native-bridge/services/openAiKeyStore.ts`:

(a) Add the in-memory field to the class (after `private migrated = false;`, line ~30):

```ts
	private sessionKey: string | null = null;
```

(b) Replace `readKey()` and `getKeyStatus()` (lines ~73–85) with:

```ts
	/** Read the persisted (encrypted, on-disk) key only. */
	private async readPersistedKey(): Promise<string | null> {
		await this.migrateIfNeeded();
		try {
			const buf = await readFile(this.keyFile());
			return this.ss().decryptString(buf);
		} catch {
			return null;
		}
	}

	async readKey(): Promise<string | null> {
		if (this.sessionKey !== null) return this.sessionKey;
		return this.readPersistedKey();
	}

	async getKeyStatus(): Promise<{
		hasKey: boolean;
		secureStorageAvailable: boolean;
		sessionOnly: boolean;
	}> {
		const persisted = await this.readPersistedKey();
		return {
			hasKey: this.sessionKey !== null || persisted !== null,
			secureStorageAvailable: this.ss().isEncryptionAvailable(),
			sessionOnly: this.sessionKey !== null && persisted === null,
		};
	}
```

(c) Replace `setKey()` (lines ~87–100) with:

```ts
	async setKey(key: string): Promise<{ success: boolean; message?: string; sessionOnly?: boolean }> {
		const trimmed = key.trim();
		if (!trimmed) return { success: false, message: "Empty key." };
		// No OS secure storage → keep the key in memory for this session only (never on disk).
		if (!this.ss().isEncryptionAvailable()) {
			this.sessionKey = trimmed;
			return { success: true, sessionOnly: true };
		}
		try {
			await mkdir(this.configDir, { recursive: true });
			await writeFile(this.keyFile(), this.ss().encryptString(trimmed));
			this.sessionKey = null; // now persisted; drop the in-memory copy
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
```

(d) In `clearKey()` (lines ~102–114), clear the session key first — add this as the first line inside the `try`:

```ts
			this.sessionKey = null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/native-bridge/services/openAiKeyStore.test.ts`
Expected: PASS (all cases — the 4 pre-existing + the 4 new).

- [ ] **Step 6: Typecheck (confirms the widened status flows through the services)**

Run: `npx tsc --noEmit`
Expected: CLEAN. (`ScriptPolishService.getKeyStatus`/`setKey` delegate to the store and its shapes stay assignable to the widened contract; no service edit needed. If tsc flags a missing field somewhere, add it there.)

- [ ] **Step 7: Commit**

```bash
git add src/native/contracts.ts electron/native-bridge/services/openAiKeyStore.ts electron/native-bridge/services/openAiKeyStore.test.ts
git commit -m "$(cat <<'EOF'
feat(key-store): in-memory session fallback when secure storage is unavailable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Surface secure-storage state in the key dialog (renderer)

**Files:**
- Modify: `src/hooks/useScriptPolish.ts`
- Modify: `src/components/video-editor/OpenAiKeyDialog.tsx`
- Modify: `src/components/video-editor/VideoEditor.tsx`
- Test: `src/components/video-editor/OpenAiKeyDialog.test.tsx` (new)

**Interfaces:**
- Consumes: `nativeBridgeClient.scriptPolish.getKeyStatus()` → `{ hasKey, secureStorageAvailable, sessionOnly }` (Task 1); `nativeBridgeClient.scriptPolish.setKey()` → `{ success, message?, sessionOnly? }` (Task 1); i18n keys `polish.keyDialog.sessionOnlyHint` and `polish.keyDialog.sessionOnlySaved` (Task 3).
- Produces: `UseScriptPolishResult.secureStorageAvailable: boolean`; `OpenAiKeyDialogProps.secureStorageAvailable: boolean`.

- [ ] **Step 1: Expose `secureStorageAvailable` from `useScriptPolish`**

In `src/hooks/useScriptPolish.ts`:

(a) Add to the `UseScriptPolishResult` interface (after `hasKey: boolean;`, line ~8):

```ts
	secureStorageAvailable: boolean;
```

(b) Add state next to `hasKey` (after `const [hasKey, setHasKey] = useState(false);`, line ~26). Default `true` so the hint doesn't flash before the first status load:

```ts
	const [secureStorageAvailable, setSecureStorageAvailable] = useState(true);
```

(c) Update `refreshKeyStatus` (line ~31–33) to read the new flag:

```ts
	const refreshKeyStatus = useCallback(async () => {
		const { hasKey: present, secureStorageAvailable: secure } =
			await nativeBridgeClient.scriptPolish.getKeyStatus();
		setHasKey(present);
		setSecureStorageAvailable(secure);
	}, []);
```

(d) Add `secureStorageAvailable` to the returned object (line ~122):

```ts
	return {
		statuses,
		hasKey,
		secureStorageAvailable,
		refreshKeyStatus,
		polishAll,
		polishSegment,
		revertSegment,
	};
```

- [ ] **Step 2: Write the failing dialog test**

Create `src/components/video-editor/OpenAiKeyDialog.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { scriptPolish: { setKey: vi.fn(), clearKey: vi.fn() } },
}));

function renderDialog(overrides: Partial<React.ComponentProps<typeof OpenAiKeyDialog>> = {}) {
	render(
		<I18nProvider>
			<OpenAiKeyDialog
				open
				hasKey={false}
				secureStorageAvailable
				onOpenChange={vi.fn()}
				onKeyStatusChange={vi.fn()}
				{...overrides}
			/>
		</I18nProvider>,
	);
}

describe("OpenAiKeyDialog", () => {
	it("shows the session-only hint when secure storage is unavailable", () => {
		renderDialog({ secureStorageAvailable: false });
		expect(screen.getByText(/this session only/i)).toBeInTheDocument();
	});

	it("does not show the hint when secure storage is available", () => {
		renderDialog({ secureStorageAvailable: true });
		expect(screen.queryByText(/this session only/i)).not.toBeInTheDocument();
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/video-editor/OpenAiKeyDialog.test.tsx`
Expected: FAIL — `secureStorageAvailable` is not a prop yet and the hint text does not render (type error / missing element).

- [ ] **Step 4: Implement the dialog changes**

In `src/components/video-editor/OpenAiKeyDialog.tsx`:

(a) Add the prop to `OpenAiKeyDialogProps` (after `hasKey: boolean;`, line ~16):

```ts
	secureStorageAvailable: boolean;
```

(b) Destructure it (in the params, after `hasKey,`, line ~23):

```ts
	secureStorageAvailable,
```

(c) Add a `note` state next to `error` (line ~30):

```ts
	const [note, setNote] = useState<string | null>(null);
```

(d) Replace the `save` function (lines ~32–47) with:

```ts
	const save = async () => {
		setBusy(true);
		setError(null);
		setNote(null);
		try {
			const res = await nativeBridgeClient.scriptPolish.setKey(value);
			if (!res.success) {
				setError(res.message ?? t("polish.keyDialog.saveError"));
				return;
			}
			setValue("");
			onKeyStatusChange();
			if (res.sessionOnly) {
				// Keep the dialog open so the user sees the session-only confirmation.
				setNote(t("polish.keyDialog.sessionOnlySaved"));
			} else {
				onOpenChange(false);
			}
		} finally {
			setBusy(false);
		}
	};
```

(e) Add the hint + note above the existing error line. Replace the `{error ? … : null}` line (line ~73) with:

```tsx
					{!secureStorageAvailable ? (
						<p className="text-xs text-amber-300/80">{t("polish.keyDialog.sessionOnlyHint")}</p>
					) : null}
					{note ? <p className="text-xs text-emerald-300">{note}</p> : null}
					{error ? <p className="text-xs text-red-300">{error}</p> : null}
```

- [ ] **Step 5: Wire the prop through `VideoEditor`**

In `src/components/video-editor/VideoEditor.tsx`:

(a) In the `useScriptPolish(...)` destructure (lines ~371–376), add `secureStorageAvailable`:

```ts
		hasKey: hasOpenAiKey,
		secureStorageAvailable: openAiSecureStorageAvailable,
		refreshKeyStatus,
```

(b) On the `<OpenAiKeyDialog … />` element (line ~3293), add the prop next to `hasKey={hasOpenAiKey}`:

```tsx
				secureStorageAvailable={openAiSecureStorageAvailable}
```

- [ ] **Step 6: Run the test + typecheck**

Run: `npx vitest run src/components/video-editor/OpenAiKeyDialog.test.tsx && npx tsc --noEmit`
Expected: PASS (2 tests) and tsc CLEAN. (Step 2's test will still fail on the i18n keys until Task 3 adds them to `en/voiceover.json`; if you run before Task 3, the hint text resolves to the raw key string. To keep this task self-contained and green, do Task 3 Step 1 (the English keys) before Step 6, or run Step 6 after Task 3.)

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useScriptPolish.ts src/components/video-editor/OpenAiKeyDialog.tsx src/components/video-editor/OpenAiKeyDialog.test.tsx src/components/video-editor/VideoEditor.tsx
git commit -m "$(cat <<'EOF'
feat(key-dialog): session-only hint + post-save note when keychain is unavailable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: i18n — `sessionOnlyHint` + `sessionOnlySaved` across 13 locales

**Files:**
- Modify: `src/i18n/locales/<locale>/voiceover.json` × 13

**Interfaces:**
- Produces: keys `polish.keyDialog.sessionOnlyHint` and `polish.keyDialog.sessionOnlySaved` in every locale's `voiceover` namespace. Consumed by `OpenAiKeyDialog` (Task 2).

- [ ] **Step 1: Add the English baseline**

In `src/i18n/locales/en/voiceover.json`, inside `polish.keyDialog` (which currently has `title`, `privacyNote`, `placeholder`, `save`, `clear`, `saveError`), add:

```json
			"sessionOnlyHint": "Your system keychain isn't available, so the key will be kept for this session only — you'll need to re-enter it after restarting.",
			"sessionOnlySaved": "Saved for this session. You'll need to re-enter the key after restarting."
```

(Match the surrounding indentation; add a comma after the previous last key `saveError`.)

- [ ] **Step 2: Add professionally translated values to the other 12 locales**

For each of `ar, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW`, add the same two keys to `polish.keyDialog` in `src/i18n/locales/<locale>/voiceover.json`, translated to match that locale's existing `polish.keyDialog.*` tone (keep "OpenAI"/product terms as-is; `ar` in Arabic script). Keys must be byte-identical to `en`.

- [ ] **Step 3: Verify parity**

Run: `npm run i18n:check`
Expected: no missing keys reported for the `voiceover` namespace in any locale. (Pre-existing `timeline.json` gaps are unrelated and out of scope.)

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/*/voiceover.json
git commit -m "$(cat <<'EOF'
i18n(key-dialog): add session-only key strings (13 locales)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Full green gate

**Files:** none (verification only).

- [ ] **Step 1: Run the pre-PR gate**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: lint clean (the pre-existing `any` warning in `src/lib/tts/synthesize.worker.ts` is unrelated), tsc clean, all unit tests pass (including the new `openAiKeyStore` + `OpenAiKeyDialog` tests).

- [ ] **Step 2: Verify i18n parity for the touched namespace**

Run: `npm run i18n:check`
Expected: `voiceover` namespace in parity across all 13 locales (pre-existing `timeline.json` debt aside).

- [ ] **Step 3: (No commit)** — this task adds no code; it gates the branch before review/merge.

---

## Self-Review

- **Spec coverage:** store session fallback + precedence + no-disk-write + clear (Task 1); widened contract (Task 1 Step 1); `getKeyStatus` `{hasKey, secureStorageAvailable, sessionOnly}` (Task 1 Step 4b); proactive hint + post-save note (Task 2); `secureStorageAvailable` plumbed via `useScriptPolish` → `VideoEditor` → dialog (Task 2 Steps 1,5); 2 i18n keys × 13 locales (Task 3); green gate + i18n:check (Task 4). All spec sections covered.
- **Placeholder scan:** none — every code/step is concrete.
- **Type consistency:** `secureStorageAvailable`/`sessionOnly` names match across contracts, store, hook, dialog, and tests. `ScriptPolishKeyStatus` (3 required fields) is what `getKeyStatus` returns; `ScriptPolishKeyResult.sessionOnly?` optional matches `setKey`'s return. `OpenAiKeyDialogProps.secureStorageAvailable` matches the VideoEditor prop pass-through.
- **Security:** the fallback path writes nothing to disk (asserted by the `readdir` test in Task 1 Step 2).
