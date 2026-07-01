import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import { stubNodeBuiltins } from "./vite-plugins/stubNodeBuiltins";

const NODE_STUB = path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts");
const ORT_STUB = path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts");
const KOKORO_VOICE_FS_STUB = path.resolve(__dirname, "src/lib/vite-stubs/kokoroVoiceFs.ts");
const KOKORO_PATH_STUB = path.resolve(__dirname, "src/lib/vite-stubs/kokoroPath.ts");

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		stubNodeBuiltins(),
		electron({
			main: {
				entry: "electron/main.ts",
				onstart({ startup }) {
					const env = { ...process.env };
					delete env.ELECTRON_RUN_AS_NODE;
					return startup(["."], { env });
				},
				vite: {
					build: {},
				},
			},
			preload: {
				input: path.join(__dirname, "electron/preload.ts"),
			},
			renderer: process.env.NODE_ENV === "test" ? undefined : {},
		}),
	],
	resolve: {
		// @xenova/transformers (v2) + @huggingface/transformers (v3, via kokoro-js):
		// env.js statically imports fs/path/url; onnx.js imports onnxruntime-node
		// (must not be bundled in the renderer — it requires fs). v3 uses the
		// `node:`-prefixed specifiers, so alias both forms to the empty stub.
		// kokoro-js also imports fs/promises and path.
		//
		// Anchored RegExp (`/^fs$/`, not `"fs"`): a bare string `find` prefix-matches, so
		// `"fs"` would also rewrite `fs/promises` → `<stub>/promises` (a broken path). The
		// anchors keep each specifier exact and let the `fs/promises` entry resolve on its own.
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "src") },
			{ find: /^fs$/, replacement: NODE_STUB },
			{ find: /^path$/, replacement: KOKORO_PATH_STUB },
			{ find: /^url$/, replacement: NODE_STUB },
			{ find: /^node:fs$/, replacement: NODE_STUB },
			{ find: /^node:path$/, replacement: KOKORO_PATH_STUB },
			{ find: /^node:url$/, replacement: NODE_STUB },
			{ find: /^fs\/promises$/, replacement: KOKORO_VOICE_FS_STUB },
			{ find: /^node:fs\/promises$/, replacement: NODE_STUB },
			{ find: /^onnxruntime-node$/, replacement: ORT_STUB }, // re-exports web ORT
		],
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers", "@huggingface/transformers", "kokoro-js"],
	},
	// The captioning worker dynamically imports @xenova/transformers, and the TTS worker
	// imports kokoro-js (which has bare Node imports). Worker bundles don't inherit the
	// top-level `plugins`, so stubNodeBuiltins is re-applied here to redirect those imports.
	worker: {
		format: "es",
		plugins: () => [stubNodeBuiltins()],
	},
	build: {
		target: "esnext",
		minify: "terser",
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				pure_funcs: ["console.log", "console.debug"],
			},
		},
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("pixi.js") || id.includes("pixi-filters") || id.includes("@pixi/"))
						return "pixi";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
					if (
						id.includes("mediabunny") ||
						id.includes("mp4box") ||
						id.includes("fix-webm-duration")
					)
						return "video-processing";
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
