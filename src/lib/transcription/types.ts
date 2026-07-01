import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment } from "@/lib/captioning";

/** Schema version stamped into cached transcripts so the cache can be invalidated on change. */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

/** A generated transcript: the raw speech-to-text source of truth (distinct from caption overlays). */
export interface Transcript {
	segments: CaptionSegment[];
	granularity: "word" | "phrase";
	provider: string;
	model: string;
	audioDurationSec: number;
	truncated: boolean;
	createdAt: number;
	schemaVersion: number;
}

/** UI-facing status of background transcription for the current video. */
export type TranscriptStatus =
	| { state: "idle" }
	| { state: "preparing-model" }
	| { state: "transcribing" }
	| { state: "ready"; transcript: Transcript }
	| { state: "no-speech" }
	| { state: "no-audio" }
	| { state: "error"; message: string };

export interface TranscribeOptions {
	trimRegions?: TrimRegion[];
	signal?: AbortSignal;
	onStatus?: (phase: "model" | "transcribe") => void;
}

/** Raw result a provider returns before it is wrapped into a {@link Transcript}. */
export interface TranscribeVideoResult {
	segments: CaptionSegment[];
	granularity: "word" | "phrase";
	audioDurationSec: number;
	truncated: boolean;
}

/** Thrown by a provider when the video has no usable audio to transcribe. */
export class TranscriptionNoAudioError extends Error {
	constructor(message = "No usable audio to transcribe.") {
		super(message);
		this.name = "TranscriptionNoAudioError";
	}
}

export interface TranscriptionProvider {
	/** Stable id, e.g. "whisper-local". */
	id: string;
	/** Model id, e.g. "whisper-tiny". */
	model: string;
	/** Transcribe a video URL into timed segments. Throws {@link TranscriptionNoAudioError} for no audio. */
	transcribe(videoUrl: string, opts?: TranscribeOptions): Promise<TranscribeVideoResult>;
}
