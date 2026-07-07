# Session-Only OpenAI Key Fallback — Design

**Date:** 2026-07-08
**Branch:** `fix/openai-key-session-fallback` (off `main`)

## Problem

On macOS, saving an OpenAI API key fails with **"Secure storage unavailable on this system."** whenever Electron `safeStorage` cannot use the login Keychain — e.g. the user denies the Keychain prompt, or the login keychain is locked / out of sync. This is amplified by the fork's **ad-hoc-signed / non-notarized** builds, which make Keychain permission grants unreliable.

The message is our own guard in `OpenAiKeyStore.setKey()`:

```ts
if (!this.ss().isEncryptionAvailable()) {
  return { success: false, message: "Secure storage unavailable on this system." };
}
```

The guard is intentional (never write the key to disk in plaintext), but it leaves affected users with **no way to use AI Script Polish or AI Doc Export at all** — both features share this key store.

## Goal

When OS secure storage is unavailable, let the user still enter and use their key **for the current session** — kept in memory only, never written to disk — and clearly tell them it won't persist across restarts. When secure storage *is* available, behavior is unchanged (encrypted persistence).

**Non-goal:** persisting the key unencrypted to disk. Security posture is unchanged: the key is only ever persisted via `safeStorage`; otherwise it lives in memory for the session and is gone on quit.

## Design

### 1. `OpenAiKeyStore` (main process) — core behavior

Add an in-memory field `private sessionKey: string | null = null`.

- **`setKey(key)`** — trim; reject empty (unchanged).
  - If `isEncryptionAvailable()`: persist encrypted to disk (as today), set `sessionKey = null`, return `{ success: true }`.
  - Else: `sessionKey = trimmed` (memory only; **nothing written to disk**), return `{ success: true, sessionOnly: true }`.
  - This removes the previous hard-failure path.
- **`readKey()`** — return `sessionKey` if set; otherwise `migrateIfNeeded()` + read the encrypted disk file (as today). Session key takes precedence (it reflects the most recent user intent).
- **`getKeyStatus()`** — return `{ hasKey, secureStorageAvailable, sessionOnly }`:
  - `secureStorageAvailable = isEncryptionAvailable()`
  - `hasKey = sessionKey != null || <encrypted disk file readable>`
  - `sessionOnly = hasKey && sessionKey != null && <no persisted disk key>` (i.e. the key exists only in memory)
- **`clearKey()`** — set `sessionKey = null` **and** remove the disk key + legacy key files (retains the durable-clear fix from v1.8.0). Return `{ success: true }`.

Migration and the durable-clear behavior added in v1.8.0 are preserved.

### 2. Contracts (`src/native/contracts.ts`) — shared wire

- `ScriptPolishKeyStatus`: add `secureStorageAvailable: boolean` and `sessionOnly: boolean`.
- `ScriptPolishKeyResult`: add optional `sessionOnly?: boolean`.

These are shared by both features: AI Doc Export reads key status via `nativeBridgeClient.scriptPolish.getKeyStatus` (the store is shared), so it inherits the richer status automatically.

### 3. Services (main)

No logic change. `ScriptPolishService.getKeyStatus/setKey/clearKey` already delegate to the shared `OpenAiKeyStore`; only the return-type annotations widen to the updated contract shapes. `DocExportService` is unaffected (it never had its own key methods).

### 4. UI — `OpenAiKeyDialog` + `VideoEditor`

- `OpenAiKeyDialog` gains a `secureStorageAvailable: boolean` prop.
- **Proactive hint:** when `!secureStorageAvailable`, render a neutral (non-error) note near the input: the key will be kept for this session only and must be re-entered after restart, because the system keychain is unavailable.
- **Post-save:** if `setKey` returns `sessionOnly: true`, show a neutral confirmation (not the red error style) and close the dialog as on success. Genuine failures (empty key) still render the red error as today.
- `VideoEditor` tracks `secureStorageAvailable` alongside the existing `hasKey` state (both come from `getKeyStatus`) and passes it to the dialog. The existing key-status refresh path is reused; no new IPC channel.

### 5. i18n (`voiceover` namespace, `polish.keyDialog.*`)

Add two keys across all 13 locales (`ar, en, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW`):

- `sessionOnlyHint` — the proactive note shown when secure storage is unavailable.
- `sessionOnlySaved` — the post-save confirmation that the key is session-only.

English baseline authored; other 12 professionally translated, matching each locale's existing `polish.keyDialog.*` tone. Verified with `npm run i18n:check` (docExport/voiceover namespaces must stay in parity; the pre-existing `timeline.json` debt is out of scope).

### 6. Testing

- **`openAiKeyStore.test.ts` (main, jsdom/node tier)** — carries the weight:
  - With a fake `safeStorage` whose `isEncryptionAvailable()` returns **false**: `setKey` returns `{ success: true, sessionOnly: true }`; `readKey` returns the entered key; `getKeyStatus` returns `{ hasKey: true, secureStorageAvailable: false, sessionOnly: true }`; **no key file is written to the config dir**; `clearKey` clears it (subsequent `readKey` → null).
  - With encryption **available**: `setKey` persists (existing round-trip tests still pass) and `getKeyStatus.sessionOnly === false`, `secureStorageAvailable === true`.
  - Session-key precedence: when a session key is set, `readKey` returns it even if a disk key also exists.
  - Existing migration + durable-clear tests remain green.
- **`scriptPolishService.test.ts`** — remains green with the widened return types (construct via the store as today).
- **Optional** light `OpenAiKeyDialog` render test: the hint appears when `secureStorageAvailable` is false.

## Files

- Modify: `electron/native-bridge/services/openAiKeyStore.ts` (+ `openAiKeyStore.test.ts`)
- Modify: `src/native/contracts.ts` (two interfaces)
- Modify: `electron/native-bridge/services/scriptPolishService.ts` (return types only)
- Modify: `src/components/video-editor/OpenAiKeyDialog.tsx`
- Modify: `src/components/video-editor/VideoEditor.tsx` (status plumbing + prop)
- Modify: `src/i18n/locales/<locale>/voiceover.json` × 13
- (No changes to `client.ts` logic; type imports already cover the shapes.)

## Out of scope

- Unencrypted on-disk persistence (rejected — security downgrade).
- Fixing macOS Keychain reliability at the OS level (requires a real Apple Developer ID / notarization — not available for this fork).
- The pre-existing `timeline.json` i18n parity debt.
