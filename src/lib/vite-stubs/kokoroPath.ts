/**
 * Minimal `path` alias target. kokoro-js (`import s from "path"`) only calls
 * `s.resolve(dir, "../voices/<id>.bin")` to build a voice path; we join the parts so
 * the `<id>.bin` basename survives for kokoroVoiceFs.readFile to parse. @huggingface/
 * transformers also imports `path` but doesn't call these in our flow (it works today
 * against an empty stub), so the extra methods are harmless.
 */
function join(...parts: Array<string | undefined>): string {
	return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("/");
}

function dirname(p: string): string {
	return String(p).replace(/[/\\][^/\\]*$/, "");
}

export default { resolve: join, join, dirname };
