import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VoiceoverClipResult } from "../../../src/native/contracts";

interface VoiceoverServiceOptions {
	/** Directory for cached clips (e.g. userData/voiceovers). */
	cacheDir: string;
}

/**
 * File-backed cache for synthesized voiceover clips, keyed by the renderer's content
 * hash (text + voice + speed + model). Each `<key>.pcm` file is self-describing:
 * [uint32 LE sampleRate][uint32 LE sampleCount][float32 PCM]. Unlike the transcript
 * cache, the key is the audio's identity, so it's stable across source videos/machines.
 */
export class VoiceoverService {
	constructor(private readonly options: VoiceoverServiceOptions) {}

	private fileFor(key: string): string {
		// Keys are hex digests, but sanitize defensively so a key can never escape the dir.
		return path.join(this.options.cacheDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.pcm`);
	}

	async getClip(key: string): Promise<VoiceoverClipResult> {
		try {
			const buf = await readFile(this.fileFor(key));
			const sampleRate = buf.readUInt32LE(0);
			const count = buf.readUInt32LE(4);
			const pcmBytes = buf.subarray(8, 8 + count * 4);
			// Ensure we return an ArrayBuffer (structured clone over IPC requires it).
			const pcm = pcmBytes.buffer.slice(
				pcmBytes.byteOffset,
				pcmBytes.byteOffset + pcmBytes.byteLength,
			);
			return { success: true, pcm, sampleRate };
		} catch {
			// Missing/unreadable → cache miss (mirrors TranscriptService.readJson).
			return { success: true };
		}
	}

	async putClip(key: string, pcm: ArrayBuffer, sampleRate: number): Promise<VoiceoverClipResult> {
		try {
			await mkdir(this.options.cacheDir, { recursive: true });
			const floats = new Float32Array(pcm);
			const header = Buffer.alloc(8);
			header.writeUInt32LE(sampleRate, 0);
			header.writeUInt32LE(floats.length, 4);
			await writeFile(this.fileFor(key), Buffer.concat([header, Buffer.from(pcm)]));
			return { success: true };
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}
