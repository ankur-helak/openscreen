export const NATIVE_BRIDGE_CHANNEL = "native-bridge:invoke";
export const NATIVE_BRIDGE_VERSION = 1;

export type NativePlatform = "darwin" | "win32" | "linux";
export type CursorProviderKind = "native" | "none";
export type NativeCursorType =
	| "arrow"
	| "text"
	| "pointer"
	| "crosshair"
	| "open-hand"
	| "closed-hand"
	| "resize-ew"
	| "resize-ns"
	| "resize-nesw"
	| "resize-nwse"
	| "move"
	| "not-allowed"
	| "wait"
	| "app-starting"
	| "help"
	| "up-arrow";

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

export interface CursorRecordingSample extends CursorTelemetryPoint {
	assetId?: string | null;
	visible?: boolean;
	cursorType?: NativeCursorType | null;
	interactionType?: "move" | "click" | "mouseup";
}

export interface NativeCursorAsset {
	id: string;
	platform: NativePlatform;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
	cursorType?: NativeCursorType | null;
}

export interface CursorRecordingData {
	version: number;
	provider: CursorProviderKind;
	samples: CursorRecordingSample[];
	assets: NativeCursorAsset[];
}

export interface CursorCapabilities {
	telemetry: boolean;
	systemAssets: boolean;
	provider: CursorProviderKind;
}

export interface SystemCapabilities {
	bridgeVersion: typeof NATIVE_BRIDGE_VERSION;
	platform: NativePlatform;
	cursor: CursorCapabilities;
	project: {
		currentContext: boolean;
	};
}

export interface ProjectContext {
	currentProjectPath: string | null;
	currentVideoPath: string | null;
}

export interface ProjectPathResult {
	success: boolean;
	path?: string;
	message?: string;
	canceled?: boolean;
	error?: string;
}

export interface ProjectFileResult {
	success: boolean;
	path?: string;
	project?: unknown;
	message?: string;
	canceled?: boolean;
	error?: string;
}

export interface TranscriptCacheResult {
	success: boolean;
	/** Serialized `Transcript` when present; `undefined`/absent on a cache miss. */
	transcript?: unknown;
	message?: string;
}

export interface CaptionDraftResult {
	success: boolean;
	/** Serialized `AnnotationRegion[]` when present; absent when no draft exists. */
	regions?: unknown;
	message?: string;
}

export interface VoiceoverClipResult {
	success: boolean;
	/** Mono Float32 PCM as an ArrayBuffer when present; absent on a cache miss. */
	pcm?: ArrayBuffer;
	/** Sample rate of the cached PCM (Kokoro: 24000). */
	sampleRate?: number;
	message?: string;
}

export interface ScriptPolishResult {
	success: boolean;
	/** Rewritten segments (id → text) when present. */
	results?: { id: string; text: string }[];
	message?: string;
	/** Machine-readable failure reason for renderer branching. */
	code?: "no-key" | "api-error" | "invalid-response";
}

export interface ScriptPolishKeyStatus {
	hasKey: boolean;
	/** Whether OS secure storage (macOS Keychain, etc.) is available for persisting the key. */
	secureStorageAvailable: boolean;
	/** True when a key is set but only held in memory for this session (not persisted). */
	sessionOnly: boolean;
}

export interface ScriptPolishKeyResult {
	success: boolean;
	message?: string;
	/** Set when the key was accepted but only kept for this session (secure storage unavailable). */
	sessionOnly?: boolean;
}

export interface DocExportGeneratedDoc {
	title: string;
	overview: string;
	audience: string[];
	learn: string[];
	steps: { id: string; heading: string; body: string }[];
}

export interface DocExportResult {
	success: boolean;
	doc?: DocExportGeneratedDoc;
	message?: string;
	code?: "no-key" | "api-error" | "invalid-response";
}

export interface DocExportSaveResult {
	success: boolean;
	path?: string;
	canceled?: boolean;
	message?: string;
}

export type NativeBridgeErrorCode =
	| "INVALID_REQUEST"
	| "UNSUPPORTED_ACTION"
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "INTERNAL_ERROR";

export interface NativeBridgeError {
	code: NativeBridgeErrorCode;
	message: string;
	retryable: boolean;
}

export interface NativeBridgeMeta {
	version: typeof NATIVE_BRIDGE_VERSION;
	requestId: string;
	timestampMs: number;
}

export interface NativeBridgeSuccess<TData> {
	ok: true;
	data: TData;
	meta: NativeBridgeMeta;
}

export interface NativeBridgeFailure {
	ok: false;
	error: NativeBridgeError;
	meta: NativeBridgeMeta;
}

export type NativeBridgeResponse<TData = unknown> =
	| NativeBridgeSuccess<TData>
	| NativeBridgeFailure;

type EmptyPayload = Record<string, never>;

export type NativeBridgeRequest =
	| {
			domain: "system";
			action: "getPlatform";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getAssetBasePath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentContext";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "saveProjectFile";
			payload: {
				projectData: unknown;
				suggestedName?: string;
				existingProjectPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFile";
			payload?: {
				/** Folder to pre-fill the open dialog with, usually the user's
				 * last-opened project folder from userPreferences. */
				projectFolder?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadCurrentProjectFile";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFileFromPath";
			payload: { path: string };
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "setCurrentVideoPath";
			payload: {
				path: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "clearCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "getTranscript";
			payload: { sourcePath: string };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "putTranscript";
			payload: { sourcePath: string; transcript: unknown };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "getCaptionDraft";
			payload: { sourcePath: string };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "putCaptionDraft";
			payload: { sourcePath: string; regions: unknown };
			requestId?: string;
	  }
	| {
			domain: "transcript";
			action: "clearCaptionDraft";
			payload: { sourcePath: string };
			requestId?: string;
	  }
	| {
			domain: "voiceover";
			action: "getVoiceoverClip";
			payload: { key: string };
			requestId?: string;
	  }
	| {
			domain: "voiceover";
			action: "putVoiceoverClip";
			payload: { key: string; pcm: ArrayBuffer; sampleRate: number };
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "polish";
			payload: {
				segments: { id: string; text: string; targetWords: number }[];
				toneInstruction: string;
			};
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "getKeyStatus";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "setKey";
			payload: { key: string };
			requestId?: string;
	  }
	| {
			domain: "scriptPolish";
			action: "clearKey";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "docExport";
			action: "generate";
			payload: {
				steps: { id: string; transcriptText: string; imageDataUrl: string }[];
				context: { transcript: string };
			};
			requestId?: string;
	  }
	| {
			domain: "docExport";
			action: "save";
			payload: { html: string };
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getTelemetry";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getRecordingData";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  };

export type NativeBridgeEventName =
	| "project.contextChanged"
	| "cursor.providerChanged"
	| "cursor.telemetryLoaded";

export interface NativeBridgeEvent<TPayload = unknown> {
	name: NativeBridgeEventName;
	payload: TPayload;
	meta: NativeBridgeMeta;
}
