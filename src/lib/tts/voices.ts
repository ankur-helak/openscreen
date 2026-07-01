import type { TtsVoice } from "./provider";

/**
 * Curated English (American + British) Kokoro voices exposed in v1. Ids match
 * `voices/<id>.bin` in the `onnx-community/Kokoro-82M-v1.0-ONNX` repo; the full
 * set is available via `KokoroTTS.list_voices()`.
 */
export const KOKORO_VOICES: TtsVoice[] = [
	{ id: "af_heart", label: "Heart — US female", lang: "en-US" },
	{ id: "af_bella", label: "Bella — US female", lang: "en-US" },
	{ id: "af_nicole", label: "Nicole — US female", lang: "en-US" },
	{ id: "am_michael", label: "Michael — US male", lang: "en-US" },
	{ id: "am_adam", label: "Adam — US male", lang: "en-US" },
	{ id: "bf_emma", label: "Emma — UK female", lang: "en-GB" },
	{ id: "bf_isabella", label: "Isabella — UK female", lang: "en-GB" },
	{ id: "bm_george", label: "George — UK male", lang: "en-GB" },
	{ id: "bm_lewis", label: "Lewis — UK male", lang: "en-GB" },
];

export const DEFAULT_KOKORO_VOICE = "af_heart";
