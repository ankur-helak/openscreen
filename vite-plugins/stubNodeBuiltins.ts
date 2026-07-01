import path from "node:path";
import type { Plugin } from "vite";

// Plugin to stub Node builtins imported by kokoro-js and transformers.
// kokoro-js ships pre-bundled with bare Node imports (`fs/promises`, `path`)
// that Vite resolve.alias doesn't reliably rewrite — this plugin intercepts
// them at the transform stage and rewrites to the stubs.
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
