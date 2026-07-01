import { useEffect, useRef } from "react";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { buildVoiceoverBedMono } from "@/lib/voiceover/bed";
import { mapSourceToOutputMs, type PlacedClip } from "@/lib/voiceover/layout";

/** Preview plays clips at their native 24 kHz; the browser resamples to the device rate. */
const PREVIEW_RATE = 24000;
/** How often to check preview drift while playing (ms). */
const RESYNC_INTERVAL_MS = 500;
/** Restart the buffer if audio/video drift exceeds this (seconds). */
const DRIFT_THRESHOLD_SEC = 0.1;

export interface UseVoiceoverPlaybackParams {
	video: HTMLVideoElement | null;
	enabled: boolean;
	isPlaying: boolean;
	isScrubbing: boolean;
	placedClips: PlacedClip[];
	clipPcmByKey: Record<string, { pcm: Float32Array; sampleRate: number }>;
	trims: TrimRegion[];
	speedRegions: SpeedRegion[];
}

/**
 * Timeline-synced voiceover preview (spec §8.7/§16). Builds ONE output-time AudioBuffer from the
 * shared bed builder and plays it with one source, started at the output-time offset mapped from
 * the video clock. Output time advances at ~1× wall-clock during playback, so a single buffer stays
 * aligned; a bounded soft re-sync caps drift from trim-skip seek latency + clock skew. Audio only —
 * the caller mutes the <video>/supplemental <audio>.
 */
export function useVoiceoverPlayback(params: UseVoiceoverPlaybackParams): void {
	const { video, enabled, isPlaying, isScrubbing, placedClips, clipPcmByKey, trims, speedRegions } =
		params;

	const ctxRef = useRef<AudioContext | null>(null);
	const bufferRef = useRef<AudioBuffer | null>(null);
	const sourceRef = useRef<AudioBufferSourceNode | null>(null);
	const startedAtCtxRef = useRef(0);
	const startedAtOffsetRef = useRef(0);
	// Latest layout inputs for the re-sync interval without re-subscribing it.
	const trimsRef = useRef(trims);
	trimsRef.current = trims;
	const speedRef = useRef(speedRegions);
	speedRef.current = speedRegions;
	const videoRef = useRef(video);
	videoRef.current = video;

	const stopSource = () => {
		const source = sourceRef.current;
		sourceRef.current = null;
		if (source) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// already stopped
			}
		}
	};

	const startSource = (offsetSec: number) => {
		const ctx = ctxRef.current;
		const buffer = bufferRef.current;
		if (!ctx || !buffer) return;
		if (offsetSec >= buffer.duration) return; // nothing left to play
		stopSource();
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		source.onended = () => {
			if (sourceRef.current === source) sourceRef.current = null;
		};
		sourceRef.current = source;
		startedAtCtxRef.current = ctx.currentTime;
		startedAtOffsetRef.current = Math.max(0, offsetSec);
		void Promise.resolve(ctx.resume?.()).finally(() => {
			if (sourceRef.current === source) {
				try {
					source.start(ctx.currentTime, Math.max(0, offsetSec));
				} catch (error) {
					console.warn("[useVoiceoverPlayback] start failed:", error);
				}
			}
		});
	};

	const outputOffsetSec = (): number => {
		const v = videoRef.current;
		if (!v) return 0;
		return mapSourceToOutputMs(v.currentTime * 1000, trimsRef.current, speedRef.current) / 1000;
	};

	// Build (or clear) the output-time buffer when enabled/placements/clips change. Declared BEFORE
	// the scheduling effect so it runs first in the same commit — the scheduler then reads a fresh
	// bufferRef. (It shares placedClips/clipPcmByKey deps with the scheduler, so both re-run together.)
	useEffect(() => {
		let buffer: AudioBuffer | null = null;
		if (enabled && placedClips.length > 0) {
			if (!ctxRef.current) ctxRef.current = new AudioContext();
			const ctx = ctxRef.current;
			const clipSamplesByKey: Record<string, Float32Array> = {};
			for (const clip of placedClips) {
				const resolved = clipPcmByKey[clip.audioKey];
				if (resolved && resolved.sampleRate === PREVIEW_RATE) {
					clipSamplesByKey[clip.audioKey] = resolved.pcm;
				}
			}
			const endMs = placedClips.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0);
			const totalSamples = Math.ceil((endMs / 1000) * PREVIEW_RATE);
			if (totalSamples > 0) {
				const bed = buildVoiceoverBedMono({
					placedClips,
					clipSamplesByKey,
					sampleRate: PREVIEW_RATE,
					totalSamples,
				});
				buffer = ctx.createBuffer(1, bed.length, PREVIEW_RATE);
				buffer.getChannelData(0).set(bed);
			}
		}
		bufferRef.current = buffer;
	}, [enabled, placedClips, clipPcmByKey]);

	// Start/stop the single source on transport changes. Re-anchor triggers are enabled/isPlaying/
	// isScrubbing (+ layout via placedClips/clipPcmByKey) — NOT raw seeked, so trim-skips don't glitch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: start/stop/offset closures + bufferRef read are intentional.
	useEffect(() => {
		if (!enabled || !video || !bufferRef.current || isScrubbing || !isPlaying) {
			stopSource();
			return;
		}
		startSource(outputOffsetSec());
		return stopSource;
	}, [enabled, video, isPlaying, isScrubbing, placedClips, clipPcmByKey]);

	// Bounded soft re-sync: while playing, cap drift between the buffer position and the video clock.
	// biome-ignore lint/correctness/useExhaustiveDependencies: start/offset closures + refs are intentional.
	useEffect(() => {
		if (!enabled || !isPlaying || isScrubbing) return;
		const id = window.setInterval(() => {
			const ctx = ctxRef.current;
			const source = sourceRef.current;
			if (!ctx || !source) return;
			const actual = startedAtOffsetRef.current + (ctx.currentTime - startedAtCtxRef.current);
			const expected = outputOffsetSec();
			if (Math.abs(actual - expected) > DRIFT_THRESHOLD_SEC) {
				startSource(expected);
			}
		}, RESYNC_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [enabled, isPlaying, isScrubbing]);

	// Release the context on unmount (inline stop so the effect needs no closure deps).
	useEffect(() => {
		return () => {
			const source = sourceRef.current;
			sourceRef.current = null;
			if (source) {
				source.onended = null;
				try {
					source.stop();
				} catch {
					// already stopped
				}
			}
			if (ctxRef.current) {
				void ctxRef.current.close();
				ctxRef.current = null;
			}
		};
	}, []);
}
