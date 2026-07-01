import type { TrimRegion } from "@/components/video-editor/types";
import {
	extractMono16kFromVideoUrl,
	shiftTrimRegionsMsForCaptionBuffer,
	transcribeMono16kToSegments,
	trimLeadingSilenceMono16k,
} from "@/lib/captioning";
import {
	type TranscribeOptions,
	type TranscribeVideoResult,
	TranscriptionNoAudioError,
	type TranscriptionProvider,
} from "../types";

const MIN_SAMPLES = 800;

/** In-renderer Whisper (transformers.js) provider. Wraps extract → trim-silence → transcribe. */
export const whisperLocalProvider: TranscriptionProvider = {
	id: "whisper-local",
	model: "whisper-tiny",

	async transcribe(videoUrl: string, opts: TranscribeOptions = {}): Promise<TranscribeVideoResult> {
		const trimRegions: TrimRegion[] = opts.trimRegions ?? [];

		const { samples, truncated, durationSec } = await extractMono16kFromVideoUrl(videoUrl, {
			signal: opts.signal,
		});
		if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < MIN_SAMPLES) {
			throw new TranscriptionNoAudioError();
		}

		const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(samples);
		if (speechSamples.length < MIN_SAMPLES) {
			throw new TranscriptionNoAudioError();
		}

		const trimMs = Math.round(trimSec * 1000);
		const shiftedTrims = shiftTrimRegionsMsForCaptionBuffer(trimRegions, trimMs);

		let { segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(speechSamples, {
			trimRegions: shiftedTrims,
			signal: opts.signal,
			onStatus: opts.onStatus,
		});
		let transcribedFromTrimmedBuffer = true;

		// Leading-silence trimming can return empty even when the full source has speech.
		if (segmentsRaw.length === 0 && trimSec > 0) {
			({ segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(samples, {
				trimRegions,
				signal: opts.signal,
				onStatus: opts.onStatus,
			}));
			transcribedFromTrimmedBuffer = false;
		}

		const segments =
			transcribedFromTrimmedBuffer && trimSec > 0
				? segmentsRaw.map((s) => ({
						...s,
						startSec: s.startSec + trimSec,
						endSec: s.endSec + trimSec,
					}))
				: segmentsRaw;

		return { segments, granularity, audioDurationSec: durationSec, truncated };
	},
};
