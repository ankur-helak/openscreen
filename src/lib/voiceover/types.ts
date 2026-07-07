import { DEFAULT_KOKORO_VOICE } from "@/lib/tts/voices";

/** Provider id for on-device Kokoro. The single value of the cloud seam in v1. */
export const VOICEOVER_ENGINE = "kokoro-local" as const;

/** One editable script line, anchored to the original spoken span. */
export interface VoiceoverSegment {
	/** "vo-<n>", allocated by the editor (see deriveNextId). */
	id: string;
	/** Anchor: original transcript segment start, in ms. */
	sourceStartMs: number;
	/** Original spoken span end, in ms (overlap/reference). */
	sourceEndMs: number;
	/** Editable script text (seeded from the transcript). */
	text: string;
	/** Snapshot taken at polish time; enables one-step per-segment revert. Absent when unpolished. */
	textBeforePolish?: string;
}

/** A segment before an id is assigned — the output of segmentation. */
export type VoiceoverSegmentDraft = Omit<VoiceoverSegment, "id">;

/** Undoable voiceover script: project-wide voice + speed, plus the segments. */
export interface VoiceoverConfig {
	enabled: boolean;
	engine: typeof VOICEOVER_ENGINE;
	voice: string;
	/** Kokoro playback rate baked into synthesis. Range 0.7–1.2; 1.0 = natural. */
	speed: number;
	/** Project-wide AI-polish tone preset id (see src/lib/script/tonePresets). Undefined → default. */
	polishTone?: string;
	segments: VoiceoverSegment[];
}

/** Runtime (non-undoable) synthesis status for one segment. */
export type SegmentSynthStatus =
	| { state: "idle" }
	| { state: "queued" }
	| { state: "synthesizing" }
	| { state: "ready"; audioKey: string; durationMs: number }
	| { state: "error"; message: string };

/** Runtime (non-undoable) AI-polish status for one segment. */
export type SegmentPolishStatus =
	| { state: "idle" }
	| { state: "queued" }
	| { state: "polishing" }
	| { state: "error"; message: string };

/** Disabled, empty script — the default for new/legacy projects. */
export const DEFAULT_VOICEOVER_CONFIG: VoiceoverConfig = {
	enabled: false,
	engine: VOICEOVER_ENGINE,
	voice: DEFAULT_KOKORO_VOICE,
	speed: 1,
	segments: [],
};
