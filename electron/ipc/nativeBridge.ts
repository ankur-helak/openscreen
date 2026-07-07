import { ipcMain } from "electron";
import {
	NATIVE_BRIDGE_CHANNEL,
	NATIVE_BRIDGE_VERSION,
	type NativeBridgeErrorCode,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectFileResult,
	type ProjectPathResult,
} from "../../src/native/contracts";
import type { CursorTelemetryLoadResult } from "../native-bridge/cursor/adapter";
import { TelemetryCursorAdapter } from "../native-bridge/cursor/telemetryCursorAdapter";
import { CursorService } from "../native-bridge/services/cursorService";
import { OpenAiKeyStore } from "../native-bridge/services/openAiKeyStore";
import { ProjectService } from "../native-bridge/services/projectService";
import { ScriptPolishService } from "../native-bridge/services/scriptPolishService";
import { SystemService } from "../native-bridge/services/systemService";
import { TranscriptService } from "../native-bridge/services/transcriptService";
import { VoiceoverService } from "../native-bridge/services/voiceoverService";
import { NativeBridgeStateStore } from "../native-bridge/store";

export interface NativeBridgeContext {
	getPlatform: () => NodeJS.Platform;
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	loadProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	loadProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
	resolveAssetBasePath: () => string | null;
	resolveVideoPath: (videoPath?: string | null) => string | null;
	loadCursorRecordingData: (
		videoPath: string,
	) => Promise<import("../../src/native/contracts").CursorRecordingData>;
	loadCursorTelemetry: (videoPath: string) => Promise<CursorTelemetryLoadResult>;
	getTranscriptCacheDir: () => string;
	getCaptionDraftsDir: () => string;
	getVoiceoverCacheDir: () => string;
	getOpenAiConfigDir: () => string;
	getLegacyScriptPolishConfigDir: () => string;
}

function normalizePlatform(platform: NodeJS.Platform): NativePlatform {
	if (platform === "darwin" || platform === "win32") {
		return platform;
	}

	return "linux";
}

function createMeta(requestId?: string) {
	return {
		version: NATIVE_BRIDGE_VERSION,
		requestId: requestId || `native-${Date.now()}`,
		timestampMs: Date.now(),
	} as const;
}

function createSuccessResponse<TData>(requestId: string | undefined, data: TData) {
	return {
		ok: true,
		data,
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse<TData>;
}

function createErrorResponse(
	requestId: string | undefined,
	code: NativeBridgeErrorCode,
	message: string,
	retryable = false,
) {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable,
		},
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse;
}

function isBridgeRequest(value: unknown): value is NativeBridgeRequest {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<NativeBridgeRequest>;
	return typeof candidate.domain === "string" && typeof candidate.action === "string";
}

export function registerNativeBridgeHandlers(context: NativeBridgeContext) {
	ipcMain.removeHandler(NATIVE_BRIDGE_CHANNEL);

	const platform = normalizePlatform(context.getPlatform());
	const store = new NativeBridgeStateStore(platform);
	const projectService = new ProjectService({
		store,
		getCurrentProjectPath: context.getCurrentProjectPath,
		getCurrentVideoPath: context.getCurrentVideoPath,
		saveProjectFile: context.saveProjectFile,
		loadProjectFile: context.loadProjectFile,
		loadCurrentProjectFile: context.loadCurrentProjectFile,
		loadProjectFileFromPath: context.loadProjectFileFromPath,
		setCurrentVideoPath: context.setCurrentVideoPath,
		getCurrentVideoPathResult: context.getCurrentVideoPathResult,
		clearCurrentVideoPath: context.clearCurrentVideoPath,
	});
	const cursorService = new CursorService({
		store,
		adapter: new TelemetryCursorAdapter({
			loadRecordingData: context.loadCursorRecordingData,
			resolveVideoPath: context.resolveVideoPath,
			loadTelemetry: context.loadCursorTelemetry,
		}),
	});
	const transcriptService = new TranscriptService({
		cacheDir: context.getTranscriptCacheDir(),
		draftsDir: context.getCaptionDraftsDir(),
		resolveSourcePath: (sourcePath: string) => context.resolveVideoPath(sourcePath),
	});
	const voiceoverService = new VoiceoverService({
		cacheDir: context.getVoiceoverCacheDir(),
	});
	const openAiKeyStore = new OpenAiKeyStore({
		configDir: context.getOpenAiConfigDir(),
		legacyDir: context.getLegacyScriptPolishConfigDir(),
	});
	const scriptPolishService = new ScriptPolishService({ keyStore: openAiKeyStore });
	const systemService = new SystemService({
		store,
		getPlatform: () => platform,
		getAssetBasePath: context.resolveAssetBasePath,
		getCursorCapabilities: () => cursorService.getCapabilities(),
	});

	ipcMain.handle(NATIVE_BRIDGE_CHANNEL, async (_, request: unknown) => {
		if (!isBridgeRequest(request)) {
			return createErrorResponse(undefined, "INVALID_REQUEST", "Invalid native bridge request.");
		}

		const requestId = request.requestId;
		const domain = request.domain as string;

		try {
			switch (request.domain) {
				case "system": {
					const action = request.action as string;
					switch (request.action) {
						case "getPlatform":
							return createSuccessResponse(requestId, systemService.getPlatform());
						case "getAssetBasePath":
							return createSuccessResponse(requestId, systemService.getAssetBasePath());
						case "getCapabilities":
							return createSuccessResponse(requestId, await systemService.getCapabilities());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported system action: ${action}`,
							);
					}
				}

				case "project": {
					const action = request.action as string;
					switch (request.action) {
						case "getCurrentContext":
							return createSuccessResponse(requestId, projectService.getCurrentContext());
						case "saveProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.saveProjectFile(
									request.payload.projectData,
									request.payload.suggestedName,
									request.payload.existingProjectPath,
								),
							);
						case "loadProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFile(request.payload?.projectFolder),
							);
						case "loadCurrentProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadCurrentProjectFile(),
							);
						case "loadProjectFileFromPath":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFileFromPath(request.payload.path),
							);
						case "setCurrentVideoPath":
							return createSuccessResponse(
								requestId,
								await projectService.setCurrentVideoPath(request.payload.path),
							);
						case "getCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.getCurrentVideoPath());
						case "clearCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.clearCurrentVideoPath());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported project action: ${action}`,
							);
					}
				}

				case "cursor": {
					const action = request.action as string;
					switch (request.action) {
						case "getCapabilities":
							return createSuccessResponse(requestId, await cursorService.getCapabilities());
						case "getTelemetry":
							return createSuccessResponse(
								requestId,
								await cursorService.getTelemetry(request.payload?.videoPath),
							);
						case "getRecordingData":
							return createSuccessResponse(
								requestId,
								await cursorService.getRecordingData(request.payload?.videoPath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported cursor action: ${action}`,
							);
					}
				}

				case "transcript": {
					const action = request.action as string;
					switch (request.action) {
						case "getTranscript":
							return createSuccessResponse(
								requestId,
								await transcriptService.getTranscript(request.payload.sourcePath),
							);
						case "putTranscript":
							return createSuccessResponse(
								requestId,
								await transcriptService.putTranscript(
									request.payload.sourcePath,
									request.payload.transcript,
								),
							);
						case "getCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.getCaptionDraft(request.payload.sourcePath),
							);
						case "putCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.putCaptionDraft(
									request.payload.sourcePath,
									request.payload.regions,
								),
							);
						case "clearCaptionDraft":
							return createSuccessResponse(
								requestId,
								await transcriptService.clearCaptionDraft(request.payload.sourcePath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported transcript action: ${action}`,
							);
					}
				}

				case "voiceover": {
					const action = request.action as string;
					switch (request.action) {
						case "getVoiceoverClip":
							return createSuccessResponse(
								requestId,
								await voiceoverService.getClip(request.payload.key),
							);
						case "putVoiceoverClip":
							return createSuccessResponse(
								requestId,
								await voiceoverService.putClip(
									request.payload.key,
									request.payload.pcm,
									request.payload.sampleRate,
								),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported voiceover action: ${action}`,
							);
					}
				}

				case "scriptPolish": {
					const action = request.action as string;
					switch (request.action) {
						case "polish":
							return createSuccessResponse(
								requestId,
								await scriptPolishService.polish(
									request.payload.segments,
									request.payload.toneInstruction,
								),
							);
						case "getKeyStatus":
							return createSuccessResponse(requestId, await scriptPolishService.getKeyStatus());
						case "setKey":
							return createSuccessResponse(
								requestId,
								await scriptPolishService.setKey(request.payload.key),
							);
						case "clearKey":
							return createSuccessResponse(requestId, await scriptPolishService.clearKey());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported scriptPolish action: ${action}`,
							);
					}
				}

				default:
					return createErrorResponse(
						requestId,
						"UNSUPPORTED_ACTION",
						`Unsupported bridge domain: ${domain}`,
					);
			}
		} catch (error) {
			return createErrorResponse(
				requestId,
				"INTERNAL_ERROR",
				error instanceof Error ? error.message : "Unknown native bridge error.",
				true,
			);
		}
	});
}
