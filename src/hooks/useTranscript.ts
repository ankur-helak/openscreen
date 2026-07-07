import { useCallback, useEffect, useRef, useState } from "react";
import type { TrimRegion } from "@/components/video-editor/types";
import {
	getActiveProvider,
	TRANSCRIPT_SCHEMA_VERSION,
	type Transcript,
	TranscriptionNoAudioError,
	type TranscriptStatus,
} from "@/lib/transcription";
import { nativeBridgeClient } from "@/native/client";

export interface UseTranscriptResult {
	status: TranscriptStatus;
	transcript: Transcript | null;
	/** Returns the ready transcript, using cache/in-flight work; generates on a miss. */
	ensureTranscript: () => Promise<Transcript | null>;
	/** Forces a fresh transcription, ignoring the cache, and rewrites it. */
	regenerate: () => Promise<Transcript | null>;
}

function isTranscript(value: unknown): value is Transcript {
	return (
		!!value &&
		typeof value === "object" &&
		Array.isArray((value as Transcript).segments) &&
		(value as Transcript).schemaVersion === TRANSCRIPT_SCHEMA_VERSION
	);
}

/**
 * Ensures a transcript exists for the loaded video: checks the sidecar cache, otherwise transcribes
 * silently in the background and writes the cache. Runs automatically when the video changes; also
 * exposes `ensureTranscript`/`regenerate` for the Auto-captions flow to reuse the same work.
 */
export function useTranscript(params: {
	videoUrl: string | null;
	sourcePath: string | null;
	trimRegions: TrimRegion[];
}): UseTranscriptResult {
	const { videoUrl, sourcePath, trimRegions } = params;

	const [status, setStatus] = useState<TranscriptStatus>({ state: "idle" });
	const [transcript, setTranscript] = useState<Transcript | null>(null);

	// One in-flight run per source path; abort on video change/unmount.
	const inFlightRef = useRef<{ key: string; promise: Promise<Transcript | null> } | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	// Latest trimRegions without making callbacks depend on their identity.
	const trimRegionsRef = useRef<TrimRegion[]>(trimRegions);
	trimRegionsRef.current = trimRegions;
	// Guard against stale runs updating state for a previous video.
	const currentSourceRef = useRef<string | null>(null);

	const run = useCallback(
		async (
			url: string,
			source: string,
			opts: { ignoreCache: boolean },
		): Promise<Transcript | null> => {
			const isCurrent = () => currentSourceRef.current === source;
			const provider = getActiveProvider();

			if (!opts.ignoreCache) {
				const cached = await nativeBridgeClient.transcript.getTranscript(source);
				// Ignore a cache entry produced by a different model so upgrading the caption model
				// (e.g. whisper-tiny → whisper-base.en) re-transcribes already-cached videos instead
				// of serving stale, lower-quality results.
				if (
					cached.success &&
					isTranscript(cached.transcript) &&
					cached.transcript.model === provider.model
				) {
					const t = cached.transcript;
					if (!isCurrent()) return null;
					setTranscript(t.segments.length > 0 ? t : null);
					setStatus(
						t.segments.length > 0 ? { state: "ready", transcript: t } : { state: "no-speech" },
					);
					return t;
				}
			}

			const controller = new AbortController();
			abortRef.current?.abort();
			abortRef.current = controller;

			setStatus({ state: "transcribing" });
			try {
				const result = await provider.transcribe(url, {
					trimRegions: trimRegionsRef.current,
					signal: controller.signal,
					onStatus: (phase) =>
						setStatus(phase === "model" ? { state: "preparing-model" } : { state: "transcribing" }),
				});
				const built: Transcript = {
					segments: result.segments,
					granularity: result.granularity,
					provider: provider.id,
					model: provider.model,
					audioDurationSec: result.audioDurationSec,
					truncated: result.truncated,
					createdAt: Date.now(),
					schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
				};
				// Cache even an empty (no-speech) result so we don't re-run every load.
				await nativeBridgeClient.transcript.putTranscript(source, built);
				if (!isCurrent()) return null;
				if (built.segments.length === 0) {
					setTranscript(null);
					setStatus({ state: "no-speech" });
				} else {
					setTranscript(built);
					setStatus({ state: "ready", transcript: built });
				}
				return built;
			} catch (error) {
				if (controller.signal.aborted) return null;
				if (error instanceof TranscriptionNoAudioError) {
					if (!isCurrent()) return null;
					setStatus({ state: "no-audio" });
					return null;
				}
				const message = error instanceof Error ? error.message : String(error);
				console.warn("[useTranscript] transcription failed:", message);
				if (!isCurrent()) return null;
				setStatus({ state: "error", message });
				return null;
			}
		},
		[],
	);

	const ensureTranscript = useCallback(async (): Promise<Transcript | null> => {
		if (!videoUrl || !sourcePath) return null;
		const key = sourcePath;
		if (inFlightRef.current?.key === key) return inFlightRef.current.promise;
		const promise = run(videoUrl, sourcePath, { ignoreCache: false }).finally(() => {
			if (inFlightRef.current?.key === key) inFlightRef.current = null;
		});
		inFlightRef.current = { key, promise };
		return promise;
	}, [videoUrl, sourcePath, run]);

	const regenerate = useCallback(async (): Promise<Transcript | null> => {
		if (!videoUrl || !sourcePath) return null;
		return run(videoUrl, sourcePath, { ignoreCache: true });
	}, [videoUrl, sourcePath, run]);

	// Auto-run silently when the video changes.
	useEffect(() => {
		if (!videoUrl || !sourcePath) {
			currentSourceRef.current = null;
			setStatus({ state: "idle" });
			setTranscript(null);
			return;
		}
		currentSourceRef.current = sourcePath;
		setTranscript(null);
		void ensureTranscript();
		return () => {
			abortRef.current?.abort();
		};
	}, [videoUrl, sourcePath, ensureTranscript]);

	return { status, transcript, ensureTranscript, regenerate };
}
