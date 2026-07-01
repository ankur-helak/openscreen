# OpenScreen — Feature Viability & Bug Audit

> **Read-only analysis.** Nothing in the codebase was changed. This document inventories
> bugs, broken/incomplete features, and viability risks so they can be reviewed. Severity
> and "will it work?" verdicts reflect static code analysis; items marked
> **Needs-runtime-verification** could not be confirmed without building and running the app.
>
> _Audit date: 2026-06-29 · Branch: `main` · Version: `1.5.0`_

---

## 0. Two things to know first

1. **The project itself is winding down.** `README.md:2` carries the author's own warning:
   _"not production grade and you'll hit bugs … This project will soon be archived."_ Treat
   everything below as "rough edges in a side project," not regressions in a maintained product.

2. **No native binaries are committed to the repo.** `/electron/native/bin/` is gitignored
   (`.gitignore:22`) and does not exist in a fresh checkout. The macOS Swift and Windows C++
   capture helpers must be **compiled before they will record** (`npm run build:native:mac` /
   `build:native:win`). This single fact drives the most serious capture findings below.

---

## 1. Direct answers to your two questions

### ❓ "Will the TTS feature work?" → **There is no TTS feature.**

A full-codebase sweep (src/, electron/, scripts/, docs/, public/, all 13 i18n locales,
package.json, git history) found **zero** text-to-speech / AI-voiceover / voice-generation
code, UI, dependency, feature flag, or string. There is no partial or abandoned scaffolding
for one either.

- The README's _"Automatic captions for voiceovers"_ (`README.md:39`) is the **opposite** of
  TTS — it transcribes the user's **own recorded voice into on-screen captions**
  (speech-to-text), it does not generate a voice from text.
- The only speech-related dependency is `@xenova/transformers` (running the **Whisper STT**
  model). No `elevenlabs`, `@aws-sdk/client-polly`, `@google-cloud/text-to-speech`, no Web
  Speech `speechSynthesis`, no native `AVSpeechSynthesizer`.
- One misleading git commit `3e3a816 "bundle tts"` actually bundles the **Whisper caption
  model** — it's an STT commit with a sloppy name.

**Bottom line:** if you expected OpenScreen to read text aloud / generate narration, that
capability does not exist and would need to be built from scratch.

### ❓ "Will the subtitles / captions feature work?" → **Mostly yes, with one real bug.**

The captioning pipeline is genuinely well-built and the **offline / on-device claim is
legitimate** for packaged builds. But there is **one confirmed correctness bug** that breaks
captions for a meaningful slice of real recordings. See [§2](#2-captions--subtitles) for detail.

| Aspect | Verdict |
|---|---|
| Common case (videos whose audio decodes via WebCodecs `decodeAudioData`) | ✅ Works |
| Offline / no-upload claim (packaged app) | ✅ Legit — model fetched at **build time**, bundled via `extraResources` |
| First-run in `npm run dev` | ⚠️ Downloads model from HuggingFace CDN (needs internet once) |
| Fallback path for WebM / native MP4 recordings that need the web-demuxer | ❌ **Broken** — wrong WASM URL |

---

## 2. Captions / Subtitles

**Code:** `src/lib/captioning/*` · **UI:** `VideoEditor.tsx` (timeline "Generate captions" button) ·
**Model:** `Xenova/whisper-tiny` via `@xenova/transformers`.

### 🔴 BUG-1 — Web-demuxer fallback uses a WASM path that doesn't exist (High)
- **Evidence:** `src/lib/captioning/extractMono16kWebDemuxer.ts:9-11` resolves
  `new URL("../exporter/wasm/web-demuxer.wasm", window.location.href)`. The wasm only ships at
  `dist/wasm/web-demuxer.wasm`. The working exporter uses the correct
  `new URL("./wasm/web-demuxer.wasm", …)` (`src/lib/exporter/streamingDecoder.ts:224`).
- **Why it matters:** This fallback runs whenever the primary `decodeAudioData` path returns
  no usable PCM — which the code itself anticipates for WebM/Matroska
  (`extractMono16k.ts:139-143`). The app records `video/webm` in the browser pipeline
  (`useScreenRecorder.ts:142-149`) and native helpers produce MP4/MOV, so this is a
  **routinely-hit path, not an edge case.** When hit, `WebDemuxer.load()` 404s and captioning
  throws `autoCaptions.failed`.
- **Status:** Likely-broken → should be runtime-verified on a real WebM recording.

### 🟡 ISSUE-2 — Multiple silent-degradation layers hide the real cause (Medium)
- **Evidence:** `extractMono16k.ts:145-149` (`catch {}` → returns null),
  `transcribeCore.ts:238-241` (a failed Whisper pass logs `console.warn` and returns `[]` →
  "no speech heard"), `extractMono16kWebDemuxer.ts:139`.
- **Why it matters:** When BUG-1 (or anything else) fails, the user sees a generic toast or an
  empty caption result with no actionable cause. Field debugging will be hard.

### 🟡 ISSUE-3 — Captioning runtime is essentially untested (Medium)
- **Evidence:** The only test is `annotationsFromCaptions.test.ts` (pure formatting math).
  Nothing exercises audio extraction, the (broken) web-demuxer wasm path, model load, or the
  worker round-trip. This is exactly why BUG-1 could ship unnoticed.

### ✅ Confirmed working
- Offline bundling pipeline: `scripts/fetch-caption-model.mjs` + `scripts/before-pack.cjs` +
  `electron-builder.json5:34-47` (`caption-assets` → `extraResources`); worker env correctly
  sets `allowRemoteModels=false`, `localModelPath`, `wasmPaths` (`transcribe.worker.ts:52-65`).
- Vite stubbing of Node `fs`/`path`/`url` + `onnxruntime-node` is correct and complete
  (`vite.config.ts:28-46`).
- Worker instantiation pattern is the canonical Vite one (`transcribe.ts:57-59`).
- Feature is reachable in the UI; **not** behind a feature flag.

---

## 3. Recording / Screen Capture (per platform)

**Code:** `electron/ipc/handlers.ts`, `src/hooks/useScreenRecorder.ts`, `electron/native/*`,
`electron/native-bridge/cursor/recording/*`.

| Platform | Will it record? | Notes |
|---|---|---|
| **macOS** | ❌ **Broken in a fresh checkout / dev** until the Swift helper is built — and a missing helper **hard-fails with no browser fallback** | The Swift ScreenCaptureKit helper is feature-complete in source, but the binary is absent. |
| **Windows** | ✅ Likely-works (after building helper); **gracefully falls back to browser capture** if the helper is missing | WGC C++ helper is feature-complete in source. |
| **Linux** | ✅ Works — browser `getDisplayMedia`/`getUserMedia` + MediaRecorder. Reduced features by design. | No native helper (by design). |

### 🔴 BUG-4 — macOS has no fallback when the native helper is missing (Critical for mac dev)
- **Evidence:** Windows missing-helper degrades gracefully
  (`useScreenRecorder.ts:796-799` → `getDisplayMedia` at `:1157-1169`). macOS **throws**
  (`useScreenRecorder.ts:912-916`, re-thrown `:1036`, toast+teardown `:1395-1410`); handler
  returns `missing-helper` (`handlers.ts:1527-1536`).
- **Why it matters:** On a fresh clone, `npm run dev` on macOS **cannot record at all** unless
  the user first runs `npm run build:native:mac` (needs Xcode/Swift). Linux/Windows would have
  fallen back to the browser path; macOS doesn't. Asymmetric and surprising.
- Additionally on macOS, the **default editable-cursor mode requires a *second* native binary**
  (the cursor helper). If it's missing, `startRecordCountdown` silently aborts
  (`useScreenRecorder.ts:1073-1076`). So macOS needs **two** built binaries to record in the
  default mode.

### 🟡 BUG-5 — Capture child processes aren't killed on app quit (Medium)
- **Evidence:** `main.ts:452-454` `will-quit` only unregisters shortcuts; nothing kills
  `nativeMacCaptureProcess` / `nativeWindowsCaptureProcess` / `cursorRecordingSession`.
- **Why it matters:** Quitting mid-recording orphans the native helper (holding the capture
  session, audio devices, and an open MP4 writer). The MP4 can be left **unfinalized/corrupt**
  and the capture device can stay held. A `before-quit` cleanup writing `stop\n`/SIGKILL is
  missing.

### 🟡 ISSUE-6 — macOS webcam is recorded via the browser, not natively (Low/Medium)
- **Evidence:** `handlers.ts:1780-1783` forces `webcam.enabled = false` in the native mac
  config; webcam is recorded separately via browser `MediaRecorder`
  (`useScreenRecorder.ts:928-956`) and attached afterward. The
  `docs/engineering/macos-native-recorder-roadmap.md` lists native webcam as the target
  end-state, but the Swift helper has **no AVFoundation webcam capture** (`main.swift:47,70`).
- **Why it matters:** The README's "webcam captured natively on macOS and Windows" is
  accurate only for Windows. A/V sync of the attached mac webcam is worth runtime-checking.

### 🟢 Smaller capture items
- `stop\n` writes on mac/win are **not** `writable`-guarded (`handlers.ts:1976`, `:2069`)
  unlike pause/resume — can emit EPIPE if the helper already exited (caught, but inconsistent).
- `inspectNativeMacCaptureOutput` re-parses the **entire** accumulated stdout buffer on every
  registration (`handlers.ts:1041-1048`) — latent double-emit + O(n) rescan; functionally
  tolerant.
- Line-buffered JSON parsing for cursor sessions is correct/partial-line-safe.

---

## 4. Export Pipeline (MP4 / GIF)

**Code:** `src/lib/exporter/*` · **UI:** `ExportDialog.tsx`, `SettingsPanel.tsx`.

| Output | Verdict |
|---|---|
| **MP4** | ✅ Likely-works — mature, defensive (config validation, HW→SW encoder fallback, stall/flush timeouts, bounded queues). Residual risks are runtime-only. |
| **GIF** | ✅ Likely-works **but** one packaging risk + a hard memory ceiling. |

### 🔴 RISK-7 — GIF worker URL unverified in packaged (`file://` + asar) build (High for GIF)
- **Evidence:** `gifExporter.ts:25` `GIF_WORKER_URL = new URL("gif.js/dist/gif.worker.js",
  import.meta.url)`; gif.js spawns it as a **classic** `new Worker(url)`. Only viable because
  the editor window sets `webSecurity:false` (`windows.ts:187-192`). **No packaged/e2e test
  covers this** — the GIF browser test runs against the Vite dev server (`http://`), not
  `file://`.
- **Why it matters:** This is the single most likely thing to break GIF export **in
  production** while passing all tests. If it fails, GIF breaks entirely; MP4 keeps working.

### 🔴 RISK-8 — GIF buffers every frame in memory → OOM on long/large clips (High)
- **Evidence:** `gifExporter.ts:285` `addFrame(canvas, {copy:true})` snapshots each frame and
  holds **all** of them until `render()`; no frame/duration cap. Size presets cap height, not
  length.
- **Why it matters:** A ~5-min 1080p/30fps GIF ≈ 9000 frames × ~8MB = tens of GB →
  guaranteed crash. MP4 does **not** have this problem (it streams chunks with a bounded
  encode queue, `videoExporter.ts:294-297`).

### 🟡 ISSUE-9 — Speed-region audio re-rendered in real time via MediaRecorder (Medium)
- **Evidence:** `audioEncoder.ts:406-600`. When speed regions exist, audio is exported by
  **actually playing** an `<audio>` element through `MediaStreamDestination` + `MediaRecorder`
  in real time, then re-demuxed/re-encoded.
- **Why it matters:** Exporting a 10-min edited clip's audio takes ~10 min wall-clock and
  depends on `preservesPitch`, `seeked`/`ended` events, and a 5s seek timeout. Most fragile +
  slowest part of export; the video path is fully offline/fast by contrast.

### 🟡 ISSUE-10 — Audio can be silently dropped; muxer errors swallowed (Medium)
- **Evidence:** No-supported-codec / zero-frames / unsupported-encode paths drop audio with
  only `console.warn` (`videoExporter.ts:277-279`, `audioEncoder.ts:266-274`…) and do **not**
  push into the user-visible `warnings[]` toast channel. Muxer `addVideoChunk` failures are
  caught and only logged (`videoExporter.ts:548-550`) — a persistent failure could yield a
  "successful" but **corrupt/truncated** MP4.

### 🟡 ISSUE-11 — Linux relies on CPU-readback workarounds (Medium, Linux only)
- **Evidence:** `videoExporter.ts:366-382`, `frameRenderer.ts:916-946` force `getImageData` /
  `gl.readPixels` on Linux because `drawImage(webglCanvas)` "fails silently, producing empty
  frames" on EGL/Ozone/Wayland. Works but slower and prone to silent regression with
  Electron/GPU-driver updates.

### 🟢 Export — confirmed strengths & dead code
- ✅ WebCodecs configs validated with `isConfigSupported` everywhere; HW→SW encoder fallback
  with platform-aware ordering; keyframe cadence + chunk-metadata handling robust.
- ✅ MP4 backpressure bounded (`MAX_ENCODE_QUEUE` 120/32) with 15s stall + 20s flush timeouts.
- 🗑️ Dead code: `asyncVideoFrameQueue.ts` (no importers), `videoDecoder.ts`'s
  `VideoFileDecoder` (only re-exported, never used).
- ⚠️ web-demuxer WASM resolution for export relies on `file://` + relative URL — works but,
  like the GIF worker, **untested in a packaged build** (and it's the front-end of *both* MP4
  and GIF non-fast-path exports).

---

## 5. IPC / API plumbing (renderer ⇄ main)

**Overall:** healthy. The newer **native bridge** (single `native-bridge:invoke` channel) is
**fully and correctly wired** — every `src/native/contracts.ts` action has a client method,
a transport dispatch, and a service implementation. No unimplemented contracts, no orphaned
services. The issues are all in the **legacy** individual-channel layer.

### 🔴 BUG-12 — `discard-cursor-telemetry` has no handler (Medium)
- **Evidence:** Renderer calls `window.electronAPI?.discardCursorTelemetry(...)`
  (`useScreenRecorder.ts:338`), preload invokes channel `"discard-cursor-telemetry"`
  (`preload.ts:132-134`), but **no `ipcMain.handle("discard-cursor-telemetry", …)` exists**.
- **Why it matters:** When a user discards an in-progress recording, this is meant to delete
  the orphaned `<video>.cursor.json` telemetry file. The invoke rejects (unhandled, since it's
  fire-and-forget), so it fails silently and **leaks a telemetry JSON file on every discarded
  recording.**

### 🟡 BUG-13 — `hud:setMicrophoneExpanded` send has no listener (Low)
- **Evidence:** `preload.ts:243-245` sends `"hud:setMicrophoneExpanded"`; no
  `ipcMain.on(...)` for it. Also a **naming inconsistency** (every other HUD channel is
  kebab-case `hud-overlay-*`). Looks like a renamed/removed listener that left the sender
  behind → silent no-op.

### 🗑️ STALE-14 — Orphaned legacy channels (Low, cleanup)
- Handlers present + preload exposed but **zero renderer callers**: `store-recorded-video`,
  `get-recorded-video-path`, `get-cursor-telemetry`, `switch-to-hud`
  (`handlers.ts:2283/2299/2342/1466`). Superseded by streaming / native-bridge paths.
- Legacy `set/get/clear-current-video-path` (`preload.ts:152-172`) are dead — the renderer
  uses the native-bridge `project.*` versions instead (`VideoEditor.tsx:582,838`).
- Orphaned listener `menu-import-video` (`preload.ts:197-201`) — the app menu never emits it
  (`main.ts:116,178-194`); a half-removed "Import Video" menu action.

---

## 6. Incomplete / disabled / stale code (codebase-wide)

> Note: the repo has **zero literal `TODO`/`FIXME`/`HACK`/`XXX` markers** — the earlier
> "~37 hits" estimate was all false positives (Tailwind `placeholder:`/`disabled:` classes,
> Vitest `stubGlobal` helpers, CSS `cursor-not-allowed`). It's a clean codebase.

### 🟡 FLAG-15 — "Blur Regions" is a complete feature hidden behind a disabled flag (Medium)
- **Evidence:** `featureFlags.ts:1` `export const BLUR_REGIONS_ENABLED = false;` (the **only**
  flag in the codebase), gated in `KeyboardShortcutsHelp.tsx:30`,
  `ShortcutsConfigDialog.tsx:147`, `SettingsPanel.tsx:814`, `timeline/TimelineEditor.tsx`.
- **Why it matters:** This is **finished, not half-done** — full UI panel
  (`BlurSettingsPanel.tsx`), constants + unit tests (`blurEffects.ts`/`.test.ts`),
  persistence (`projectPersistence.ts:325`), preview render, **and export-pipeline rendering**
  (`annotationRenderer.ts:158,194,487`). Flipping the flag to `true` would expose an
  apparently production-ready feature. Decision needed: ship or delete.

### 🟡 I18N-16 — Translations are out of sync; `i18n:check` FAILS (Medium, user-facing)
- **Evidence:** `node scripts/i18n-check.mjs` exits **FAILED**. 12 non-English locales are
  missing keys for newer features: `buttons.autoZoomOn/Off`, `buttons.autoFocusAll*`,
  `textAnimation.*`, `emptyState.*`, `unsavedChanges.*`, `sourceSelector.empty*`,
  `zoom.focusMode.lockedDisclaimer`, `support.reportBug/saveDiagnostics/starOnGithub`, etc.
  Namespaces hit: `dialogs.json`, `launch.json`, `settings.json`, `timeline.json` (all 12);
  plus `editor.json`/`shortcuts.json` for a couple.
- **Why it matters:** Non-English UI falls back to English/raw keys for those features. The
  check is **not wired into CI/pre-commit** (`scripts/CLAUDE.md:32` — "run manually"), which
  is why it drifted.

### 🗑️ STALE-17 — Orphaned component files (Low, cleanup)
- `FormatSelector.tsx`, `GifOptionsPanel.tsx` — both superseded by inline selectors in
  `SettingsPanel.tsx`; **zero references.**
- `TutorialHelp.tsx` — never rendered (only referenced by a translation-parity test).
- `BlurSettingsPanel.tsx` — only reachable via the disabled blur flag (dead as shipped).

### 🟡 Documented-but-not-built / known limitations
| Item | Status | Evidence |
|---|---|---|
| macOS native webcam compositing | Not built (browser sidecar instead) | roadmap `:110,172-182`; `main.swift:47,70` |
| Windows native-cursor "click bounce" | Wired in editor, **no visible effect** in packaged app | `docs/testing/windows-native-cursor.md:87-91` |
| Linux native capture (cursor themes/click fx, native webcam, reliable sys-audio) | By-design non-goal | `README.md:156-162` |
| macOS native microphone | Version-gated (needs SCK mic output) | roadmap `:160-170`; `main.swift:170-176` |
| macOS system audio ≤ macOS 12 | Unsupported | `README.md:159-162` |
| Native-bridge migration | Partial scaffold; ~131 legacy `electronAPI` refs remain | `docs/architecture/native-bridge.md:29-38` |
| Native "restart" recording | Stop-discard-start stopgap | roadmaps |

---

## 7. Prioritized issue list

| # | Severity | Area | Issue | Key evidence |
|---|---|---|---|---|
| BUG-1 | 🔴 High | Captions | Web-demuxer fallback WASM URL is wrong → captions fail on WebM/native recordings | `extractMono16kWebDemuxer.ts:9-11` |
| BUG-4 | 🔴 Critical (mac dev) | Capture | macOS hard-fails with no browser fallback when native helper missing | `useScreenRecorder.ts:912-916` |
| RISK-7 | 🔴 High (GIF) | Export | GIF worker URL unverified in packaged `file://` build | `gifExporter.ts:25` |
| RISK-8 | 🔴 High | Export | GIF buffers all frames → OOM on long clips | `gifExporter.ts:285` |
| BUG-12 | 🟡 Medium | IPC | `discard-cursor-telemetry` has no handler → leaks telemetry files | `preload.ts:132-134` |
| BUG-5 | 🟡 Medium | Capture | Native helpers not killed on quit → corrupt MP4 / held devices | `main.ts:452-454` |
| ISSUE-9 | 🟡 Medium | Export | Speed-region audio re-rendered in real time (slow/fragile) | `audioEncoder.ts:406-600` |
| ISSUE-10 | 🟡 Medium | Export | Silent audio drops + swallowed muxer errors → possibly corrupt MP4 | `videoExporter.ts:548-550` |
| FLAG-15 | 🟡 Medium | Features | Complete "Blur Regions" feature hidden behind disabled flag | `featureFlags.ts:1` |
| I18N-16 | 🟡 Medium | i18n | `i18n:check` failing; 12 locales missing newer keys | `scripts/i18n-check.mjs` |
| ISSUE-2/3 | 🟡 Medium | Captions | Silent-degradation layers + no runtime tests | `transcribeCore.ts:238-241` |
| ISSUE-11 | 🟡 Medium (Linux) | Export | CPU-readback workaround for empty GPU frames | `videoExporter.ts:366-382` |
| ISSUE-6 | 🟢 Low/Med | Capture | macOS webcam via browser, not native (README overstates) | `handlers.ts:1780-1783` |
| BUG-13 | 🟢 Low | IPC | `hud:setMicrophoneExpanded` send has no listener | `preload.ts:243-245` |
| STALE-14/17 | 🗑️ Low | Cleanup | Orphaned IPC channels + 3 orphaned component files | see §5/§6 |
| TTS | ℹ️ N/A | — | No TTS feature exists at all | (whole-repo sweep) |

---

## 8. Things that are genuinely solid (so you don't waste time re-checking)

- **Native bridge IPC layer** — fully wired, no contract drift.
- **MP4 export core** — config validation, encoder fallback, bounded queues, timeouts.
- **Caption offline bundling** — build-time model fetch + `extraResources`; the offline claim holds.
- **Vite stubbing** for `@xenova/transformers` Node-builtin leakage — correct and complete.
- **No stub/`not implemented`/dead-throw landmines** — `throw` sites are all legitimate validation.
- **Linux recording** — correctly wired through the browser pipeline (with documented feature gaps).

---

## 9. Suggested runtime verifications (when you build the app)

These are the highest-value "actually run it" checks, since static analysis can't settle them:

1. Generate captions on a **real WebM screen recording** → confirms/denies BUG-1.
2. Export a **GIF from a packaged installer build** (not dev) → confirms/denies RISK-7.
3. Export a **long GIF** (a few minutes) → confirms/denies the RISK-8 OOM.
4. On a **fresh macOS clone without building helpers**, try to record → confirms BUG-4.
5. **Quit the app mid-recording** → check whether the output MP4 is finalized (BUG-5).
6. Export audio on a **timeline with speed regions** → exercises the fragile path (ISSUE-9).
