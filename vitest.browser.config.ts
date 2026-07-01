import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { stubNodeBuiltins } from "./vite-plugins/stubNodeBuiltins";

const NODE_STUB = path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts");
const ORT_STUB = path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts");

export default defineConfig({
	plugins: [stubNodeBuiltins()],
	test: {
		include: ["src/**/*.browser.test.{ts,tsx}"],
		browser: {
			enabled: true,
			provider: playwright({
				launch: {
					// Software WebGL so Pixi.js works in headless CI without a GPU.
					args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
				},
			}),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
		testTimeout: 120_000,
		hookTimeout: 30_000,
	},
	resolve: {
		// See vite.config.ts for why these are anchored RegExp (bare-string `fs` would
		// prefix-match and mangle `fs/promises` → `<stub>/promises`).
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "src") },
			{ find: /^fs$/, replacement: NODE_STUB },
			{ find: /^path$/, replacement: NODE_STUB },
			{ find: /^url$/, replacement: NODE_STUB },
			{ find: /^node:fs$/, replacement: NODE_STUB },
			{ find: /^node:path$/, replacement: NODE_STUB },
			{ find: /^node:url$/, replacement: NODE_STUB },
			{ find: /^fs\/promises$/, replacement: NODE_STUB },
			{ find: /^node:fs\/promises$/, replacement: NODE_STUB },
			{ find: /^onnxruntime-node$/, replacement: ORT_STUB }, // re-exports web ORT
		],
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers", "@huggingface/transformers", "kokoro-js"],
	},
	// The captioning worker dynamically imports @xenova/transformers, and the TTS worker
	// imports kokoro-js (which has bare Node imports). Worker bundles code-split and need
	// the stubNodeBuiltins plugin to rewrite kokoro-js imports.
	worker: {
		format: "es",
		plugins: () => [stubNodeBuiltins()],
	},
	assetsInclude: ["**/*.webm"],
});
