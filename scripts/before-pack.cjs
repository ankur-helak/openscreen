// electron-builder beforePack hook: ensure the auto-caption (Whisper) and TTS (Kokoro) assets exist
// before packaging, so the `caption-assets` / `tts-assets` extraResources entries have something to
// copy. Runs on every package invocation. Both fetch scripts are idempotent (no-ops once present).

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function beforePack() {
	for (const script of ["fetch-caption-model.mjs", "fetch-tts-model.mjs"]) {
		execFileSync("node", [path.join(__dirname, script)], {
			stdio: "inherit",
			cwd: path.join(__dirname, ".."),
		});
	}
};
