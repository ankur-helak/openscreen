import { useCallback, useEffect, useRef, useState } from "react";
import type { Transcript } from "@/lib/transcription";
import { getKokoroProvider } from "@/lib/tts/kokoroProvider";
import type { TtsProvider } from "@/lib/tts/provider";
import { computeAudioKey } from "@/lib/voiceover/audioKey";
import { segmentTranscript } from "@/lib/voiceover/segmentation";
import type { SegmentSynthStatus, VoiceoverConfig, VoiceoverSegment } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";

export interface ResolvedClip {
	pcm: Float32Array;
	sampleRate: number;
	durationMs: number;
}

export interface UseVoiceoverResult {
	statuses: Record<string, SegmentSynthStatus>;
	clips: Record<string, ResolvedClip>;
	audioKeyFor: (segment: VoiceoverSegment) => string;
	seedFromTranscript: () => void;
	generateSegment: (id: string) => Promise<void>;
	generateAll: () => Promise<void>;
}

function durationMsOf(pcmLength: number, sampleRate: number): number {
	return Math.round((pcmLength / sampleRate) * 1000);
}

/**
 * Orchestrates voiceover synthesis for the current script. The script itself is undoable
 * editor state (`config`, mutated via `onChange`); per-segment synthesis status and
 * resolved audio are runtime-only and owned here. Mirrors useTranscript, but per-segment.
 */
export function useVoiceover(params: {
	config: VoiceoverConfig;
	transcript: Transcript | null;
	onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void;
	provider?: TtsProvider;
}): UseVoiceoverResult {
	const { config, transcript, onChange } = params;
	const provider = params.provider ?? getKokoroProvider();

	const [statuses, setStatuses] = useState<Record<string, SegmentSynthStatus>>({});
	const [clips, setClips] = useState<Record<string, ResolvedClip>>({});

	// Latest values without making callbacks depend on their identity.
	const configRef = useRef(config);
	configRef.current = config;
	const providerRef = useRef(provider);
	providerRef.current = provider;
	const statusesRef = useRef(statuses);
	statusesRef.current = statuses;

	const audioKeyFor = useCallback(
		(segment: VoiceoverSegment) =>
			computeAudioKey({
				text: segment.text,
				voice: configRef.current.voice,
				speed: configRef.current.speed,
			}),
		[],
	);

	const seedFromTranscript = useCallback(() => {
		const cfg = configRef.current;
		if (cfg.segments.length > 0) return;
		const source = transcript?.segments ?? [];
		if (source.length === 0) return;
		const drafts = segmentTranscript(source);
		if (drafts.length === 0) return;
		const segments: VoiceoverSegment[] = drafts.map((d, i) => ({ id: `vo-${i + 1}`, ...d }));
		onChange((prev) => (prev.segments.length > 0 ? prev : { ...prev, segments }));
	}, [transcript, onChange]);

	const generateSegment = useCallback(async (id: string) => {
		const segment = configRef.current.segments.find((s) => s.id === id);
		if (!segment) return;
		const inFlight = statusesRef.current[id]?.state;
		if (inFlight === "synthesizing") return;
		const key = computeAudioKey({
			text: segment.text,
			voice: configRef.current.voice,
			speed: configRef.current.speed,
		});
		setStatuses((prev) => {
			const next: Record<string, SegmentSynthStatus> = { ...prev, [id]: { state: "synthesizing" } };
			statusesRef.current = next;
			return next;
		});
		try {
			const { pcm, sampleRate } = await providerRef.current.synthesize(segment.text, {
				voice: configRef.current.voice,
				speed: configRef.current.speed,
			});
			const durationMs = durationMsOf(pcm.length, sampleRate);
			const pcmBuffer = pcm.buffer.slice(
				pcm.byteOffset,
				pcm.byteOffset + pcm.byteLength,
			) as ArrayBuffer;
			await nativeBridgeClient.voiceover.putClip(key, pcmBuffer, sampleRate);
			setClips((prev) => ({ ...prev, [key]: { pcm, sampleRate, durationMs } }));
			setStatuses((prev) => ({ ...prev, [id]: { state: "ready", audioKey: key, durationMs } }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[useVoiceover] synthesis failed:", message);
			setStatuses((prev) => ({ ...prev, [id]: { state: "error", message } }));
		}
	}, []);

	const generateAll = useCallback(async () => {
		const pending = configRef.current.segments.filter(
			(s) => statusesRef.current[s.id]?.state !== "ready",
		);
		if (pending.length > 0) {
			setStatuses((prev) => {
				const next: Record<string, SegmentSynthStatus> = { ...prev };
				for (const s of pending) next[s.id] = { state: "queued" };
				statusesRef.current = next;
				return next;
			});
		}
		for (const segment of pending) {
			if (statusesRef.current[segment.id]?.state === "ready") continue;
			await generateSegment(segment.id);
		}
	}, [generateSegment]);

	// Resolve each segment against the cache when the script/voice/speed changes.
	// Cache hit → ready (+ decoded clip); miss → idle (awaiting explicit generation).
	// Reads statusesRef without listing it as a dep to avoid re-running on every status change.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			for (const segment of config.segments) {
				const key = computeAudioKey({
					text: segment.text,
					voice: config.voice,
					speed: config.speed,
				});
				const current = statusesRef.current[segment.id];
				if (current?.state === "ready" && current.audioKey === key) continue;
				if (current?.state === "synthesizing" || current?.state === "queued") continue;
				const hit = await nativeBridgeClient.voiceover.getClip(key);
				if (cancelled) return;
				if (hit.success && hit.pcm && typeof hit.sampleRate === "number") {
					const pcm = new Float32Array(hit.pcm);
					const durationMs = durationMsOf(pcm.length, hit.sampleRate);
					setClips((prev) => ({
						...prev,
						[key]: { pcm, sampleRate: hit.sampleRate as number, durationMs },
					}));
					setStatuses((prev) => ({
						...prev,
						[segment.id]: { state: "ready", audioKey: key, durationMs },
					}));
				} else {
					setStatuses((prev) => ({ ...prev, [segment.id]: { state: "idle" } }));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
		// Re-resolve when the segments, voice, or speed change.
	}, [config.segments, config.voice, config.speed]);

	return { statuses, clips, audioKeyFor, seedFromTranscript, generateSegment, generateAll };
}
