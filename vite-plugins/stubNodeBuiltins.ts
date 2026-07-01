import path from "node:path";
import type { Plugin } from "vite";

// Stubs the Node builtins that kokoro-js / @huggingface/transformers import
// (`fs`, `path`, `url`, `fs/promises`, `onnxruntime-node`) with web-safe shims so
// the renderer and worker bundles never pull in Node-only code. `enforce: "pre"`
// runs the `resolveId` redirect ahead of Vite's default resolution. Wire this into
// both the top-level `plugins` and `worker.plugins` (worker bundles keep their own
// plugin list); `resolve.alias` in vite.config.ts covers the same specifiers for the
// main bundle.
export function stubNodeBuiltins(): Plugin {
	const stubPath = path.resolve(__dirname, "../src/lib/vite-stubs/empty-node-module.ts");
	const ortStubPath = path.resolve(__dirname, "../src/lib/vite-stubs/onnxruntime-node-stub.ts");
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
		resolveId(id) {
			if (stubs.has(id)) {
				return stubPath;
			}
			if (id === "onnxruntime-node") {
				return ortStubPath;
			}
		},
	};
}
