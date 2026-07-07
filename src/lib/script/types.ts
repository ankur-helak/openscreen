/** One segment sent to the polisher: its id, current words, and a soft word budget. */
export interface PolishSegmentInput {
	id: string;
	text: string;
	targetWords: number;
}

/** One rewritten segment returned by the polisher, keyed by the input id. */
export interface PolishSegmentResult {
	id: string;
	text: string;
}

/** A project-wide tone preset. `instruction` is what the LLM actually receives. */
export interface TonePreset {
	id: string;
	/** i18n key under the `voiceover` namespace: `polish.tone.<id>`. */
	labelKey: string;
	instruction: string;
}
