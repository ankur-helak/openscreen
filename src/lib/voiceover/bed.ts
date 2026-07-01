import type { PlacedClip } from "./layout";

/**
 * Write each placed clip's samples into a silent mono bed at its output-time position.
 * Pure — shared by preview (24 kHz AudioBuffer) and export (48 kHz PCM track) so both lay
 * clips down identically. `clipSamplesByKey` must already be at `sampleRate`; clips with no
 * samples are skipped, and writes are clamped to the bed length.
 */
export function buildVoiceoverBedMono(input: {
	placedClips: PlacedClip[];
	clipSamplesByKey: Record<string, Float32Array>;
	sampleRate: number;
	totalSamples: number;
}): Float32Array {
	const bed = new Float32Array(Math.max(0, input.totalSamples));
	for (const clip of input.placedClips) {
		const samples = input.clipSamplesByKey[clip.audioKey];
		if (!samples || samples.length === 0) continue;
		const startSample = Math.round((clip.startMs / 1000) * input.sampleRate);
		if (startSample >= bed.length) continue;
		const writable = Math.min(samples.length, bed.length - startSample);
		if (writable <= 0) continue;
		bed.set(writable === samples.length ? samples : samples.subarray(0, writable), startSample);
	}
	return bed;
}
