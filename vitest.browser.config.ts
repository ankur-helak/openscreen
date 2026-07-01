import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";

// Plugin to stub Node builtins imported by kokoro-js and transformers
function stubNodeBuiltins(): Plugin {
	const stubPath = path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts");
	const ortStubPath = path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts");
	const stubs = new Set([
		"fs",
		"path",
		"url",
		"node:fs",
		"node:path",
		"node:url",
		"fs/promises",
		"node:fs/promises",
	]);
	return {
		name: "stub-node-builtins",
		enforce: "pre",
		resolveId(id, importer) {
			if (stubs.has(id)) {
				return stubPath;
			}
			if (id === "onnxruntime-node") {
				return ortStubPath;
			}
		},
		transform(code, id) {
			// Rewrite imports within kokoro-js to point to our stubs
			if (id.includes("kokoro-js")) {
				let transformed = code;
				transformed = transformed.replace(
					/import\s+(\w+)\s+from\s*["']fs\/promises["']/g,
					`import $1 from "${stubPath}"`,
				);
				transformed = transformed.replace(
					/import\s+(\w+)\s+from\s*["']path["']/g,
					`import $1 from "${stubPath}"`,
				);
				if (transformed !== code) {
					return { code: transformed, map: null };
				}
			}
		},
	};
}

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
	// The captioning worker dynamically imports @xenova/transformers, which makes the
	// worker bundle code-split — unsupported by the default "iife" worker format.
	worker: {
		format: "es",
	},
	assetsInclude: ["**/*.webm"],
});
