import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { stubNodeBuiltins } from "./vite-plugins/stubNodeBuiltins";

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
		alias: {
			"@": path.resolve(__dirname, "src"),
			// @xenova/transformers (v2) + @huggingface/transformers (v3, via kokoro-js):
			// env.js statically imports fs/path/url; onnx.js imports onnxruntime-node
			// (must not be bundled in the renderer — it requires fs). v3 uses the
			// `node:`-prefixed specifiers, so alias both forms to the empty stub.
			// kokoro-js also imports fs/promises and path.
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:fs": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:path": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:url": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"fs/promises": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"node:fs/promises": path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"), // re-exports web ORT
		},
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
