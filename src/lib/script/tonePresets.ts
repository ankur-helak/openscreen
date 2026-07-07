import type { TonePreset } from "./types";

/** Default preset: rewrites for clarity while preserving the speaker's own phrasing. */
export const DEFAULT_TONE_ID = "conversational";

export const TONE_PRESETS: TonePreset[] = [
	{
		id: "conversational",
		labelKey: "polish.tone.conversational",
		instruction:
			"Rewrite in a natural, conversational voice. Preserve the speaker's own phrasing and meaning; only remove filler words, false starts, and stumbles. Do not make it sound corporate or AI-generated.",
	},
	{
		id: "professional",
		labelKey: "polish.tone.professional",
		instruction:
			"Rewrite in a clear, professional voice suitable for a product demo. Keep it precise and confident without jargon or hype.",
	},
	{
		id: "concise",
		labelKey: "polish.tone.concise",
		instruction:
			"Rewrite as concisely as possible while preserving the meaning. Prefer short, direct sentences.",
	},
	{
		id: "enthusiastic",
		labelKey: "polish.tone.enthusiastic",
		instruction:
			"Rewrite with an upbeat, enthusiastic energy, while staying natural and not over-the-top.",
	},
	{
		id: "tutorial",
		labelKey: "polish.tone.tutorial",
		instruction:
			"Rewrite as clear step-by-step tutorial narration. Use direct instructional phrasing (e.g. 'Next, open Settings').",
	},
];

/** Resolve a preset id (or undefined) to its instruction, defaulting safely. */
export function resolveToneInstruction(toneId: string | undefined): string {
	const preset = TONE_PRESETS.find((p) => p.id === toneId);
	return (preset ?? TONE_PRESETS.find((p) => p.id === DEFAULT_TONE_ID) ?? TONE_PRESETS[0])
		.instruction;
}
