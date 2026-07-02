// Populates `tts-assets/` so the packaged app can synthesize speech offline (under file://)
// instead of fetching the Kokoro model from HuggingFace and the onnxruntime wasm from a CDN.
//
//   tts-assets/
//     models/onnx-community/Kokoro-82M-v1.0-ONNX/...   ← config, tokenizer, q8 onnx, voice .bin files
//     ort/*.wasm + ort-wasm-*.mjs                      ← wasm binary + its JS loader glue, from @huggingface/transformers/dist
//
// Idempotent: existing non-empty files are left alone, so re-runs and CI cache hits are no-ops.
// `tts-assets/` is gitignored and shipped via electron-builder `extraResources`.

import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tts-assets");
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

// Curated English voices exposed in v1 (must match src/lib/tts/voices.ts).
const VOICES = [
	"af_heart",
	"af_bella",
	"af_nicole",
	"am_michael",
	"am_adam",
	"bf_emma",
	"bf_isabella",
	"bm_george",
	"bm_lewis",
];

// dtype "q8" → onnx/model_quantized.onnx. Grab metadata files transformers may request.
const MODEL_FILES = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"onnx/model_quantized.onnx",
	...VOICES.map((v) => `voices/${v}.bin`),
];

async function exists(filePath) {
	try {
		const s = await stat(filePath);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, retryAfter) {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url) {
	let lastErr;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, { headers: { "user-agent": "openscreen-build" } });
			if (res.ok && res.body) return res;
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				const wait = backoffMs(attempt, res.headers.get("retry-after"));
				console.log(
					`  … HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
				);
				await sleep(wait);
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			const isHttp = err instanceof Error && err.message.startsWith("Failed to download");
			if (isHttp || attempt >= MAX_ATTEMPTS) throw err;
			const wait = backoffMs(attempt, null);
			console.log(
				`  … ${err.message}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
			);
			await sleep(wait);
		}
	}
	throw lastErr;
}

async function download(url, dest) {
	if (await exists(dest)) {
		console.log(`  ✓ cached  ${path.relative(OUT, dest)}`);
		return;
	}
	await mkdir(path.dirname(dest), { recursive: true });
	const res = await fetchWithRetry(url);
	const tmp = `${dest}.partial`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	const { rename } = await import("node:fs/promises");
	await rename(tmp, dest);
	const mb = ((await stat(dest)).size / 1_000_000).toFixed(1);
	console.log(`  ↓ ${path.relative(OUT, dest)} (${mb} MB)`);
}

async function copyOrtWasm() {
	const distDir = path.join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
	const ortOut = path.join(OUT, "ort");
	await mkdir(ortOut, { recursive: true });
	let entries;
	try {
		entries = await readdir(distDir);
	} catch {
		throw new Error(
			`Missing ${distDir} — is @huggingface/transformers installed? Run npm ci first.`,
		);
	}
	// ORT ships each wasm backend as a .wasm binary + a matching .mjs loader module. The TTS
	// worker overrides env.backends.onnx.wasm.wasmPaths to this dir, so ORT runtime-imports the
	// ort-wasm-*.mjs glue from here too — shipping only .wasm leaves synthesis dead with "no
	// available backend found" under file:// (see src/lib/tts/synthesize.worker.ts).
	const assets = entries.filter((f) => f.endsWith(".wasm") || /^ort-wasm.*\.mjs$/.test(f));
	if (assets.length === 0) throw new Error(`No ort wasm assets found in ${distDir}`);
	for (const name of assets) {
		const dest = path.join(ortOut, name);
		if (await exists(dest)) {
			console.log(`  ✓ cached  ort/${name}`);
			continue;
		}
		await copyFile(path.join(distDir, name), dest);
		console.log(`  + copied ort/${name}`);
	}
}

async function main() {
	console.log(`Fetching TTS assets → ${path.relative(ROOT, OUT)}/`);
	console.log("ONNX Runtime wasm:");
	await copyOrtWasm();
	console.log(`Kokoro model (${MODEL_ID}):`);
	const modelDir = path.join(OUT, "models", ...MODEL_ID.split("/"));
	for (const rel of MODEL_FILES) {
		await download(`${HF_BASE}/${rel}`, path.join(modelDir, rel));
	}
	console.log("TTS assets ready.");
}

main().catch((err) => {
	console.error(`\nfetch-tts-model failed: ${err.message}`);
	process.exit(1);
});
