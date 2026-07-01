import { whisperLocalProvider } from "./providers/whisperLocal";
import type { TranscriptionProvider } from "./types";

/** Registered providers, keyed by id. Add offline/API providers here as they are implemented. */
const PROVIDERS: Record<string, TranscriptionProvider> = {
	[whisperLocalProvider.id]: whisperLocalProvider,
};

/** Id of the provider used when none is explicitly configured. */
export const DEFAULT_PROVIDER_ID = whisperLocalProvider.id;

/**
 * Returns the active transcription provider. Configuration is a constant today; a settings-driven
 * selector can override `id` later without changing callers.
 */
export function getActiveProvider(id: string = DEFAULT_PROVIDER_ID): TranscriptionProvider {
	const provider = PROVIDERS[id];
	if (!provider) {
		throw new Error(`[transcription] Unknown provider id: ${id}`);
	}
	return provider;
}

/** Ids of all registered providers (for future settings UI). */
export function listProviderIds(): string[] {
	return Object.keys(PROVIDERS);
}
