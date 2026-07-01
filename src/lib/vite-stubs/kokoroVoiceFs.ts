/**
 * Vite alias target for kokoro-js's `import i from "fs/promises"`. kokoro loads voice
 * style vectors with `if (Object.hasOwn(i, "readFile")) { ... i.readFile(path) }`,
 * otherwise it fetches them from the HuggingFace CDN — which fails in a packaged,
 * offline app under file://. We expose `readFile` ONLY while a voice base URL is set
 * (the packaged/offline branch), fetching the bundled `voices/<id>.bin`. When unset
 * (dev/CDN), `readFile` is absent so kokoro keeps its normal remote path.
 *
 * The worker sets the base URL via setKokoroVoiceBaseUrl(); because the alias and the
 * worker's own import resolve to this same module, they share `voiceBaseUrl`.
 */
interface VoiceFsShim {
	readFile?: (p: string) => Promise<{ buffer: ArrayBuffer }>;
}

let voiceBaseUrl: string | null = null;

async function readFile(p: string): Promise<{ buffer: ArrayBuffer }> {
	const id = /([^/\\]+)\.bin$/.exec(String(p))?.[1];
	if (!id) throw new Error(`[tts] cannot parse voice id from path: ${p}`);
	if (!voiceBaseUrl) throw new Error("[tts] voice base URL not set");
	const url = new URL(`${id}.bin`, voiceBaseUrl).href;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`[tts] voice fetch failed for ${id}: HTTP ${res.status}`);
	return { buffer: await res.arrayBuffer() };
}

const shim: VoiceFsShim = {};

/** Enable bundled-voice reads (packaged/offline). Pass null to restore the dev/CDN path. */
export function setKokoroVoiceBaseUrl(url: string | null): void {
	voiceBaseUrl = url;
	if (url) {
		shim.readFile = readFile;
	} else {
		shim.readFile = undefined;
		delete shim.readFile;
	}
}

export default shim;
