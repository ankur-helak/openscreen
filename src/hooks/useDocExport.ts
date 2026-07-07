import { useCallback, useEffect, useState } from "react";
import { deriveSteps, renderDocHtml, validateGeneratedDoc } from "@/lib/docExport";
import { captureStepScreenshots, type DocScreenshotConfig } from "@/lib/docExport/screenshots";
import type { DeriveStepsInput } from "@/lib/docExport/types";
import { nativeBridgeClient } from "@/native/client";

export type DocExportStatus =
	| { state: "idle" | "capturing" | "generating" | "rendering" | "saving" }
	| { state: "error"; message: string };

export interface UseDocExportParams {
	hasTranscript: boolean;
	getFullTranscriptText: () => string;
	getDeriveInputs: () => DeriveStepsInput;
	getScreenshotConfig: () => DocScreenshotConfig | null;
}

export interface UseDocExportResult {
	status: DocExportStatus;
	hasKey: boolean;
	refreshKeyStatus: () => Promise<void>;
	exportDoc: () => Promise<void>;
}

/**
 * Orchestrates Doc Export: deriveSteps → capture screenshots → multimodal generate → validate →
 * render self-contained HTML → save. Any failure aborts the whole run (nothing is written).
 */
export function useDocExport(params: UseDocExportParams): UseDocExportResult {
	const { getFullTranscriptText, getDeriveInputs, getScreenshotConfig } = params;
	const [status, setStatus] = useState<DocExportStatus>({ state: "idle" });
	const [hasKey, setHasKey] = useState(false);

	const refreshKeyStatus = useCallback(async () => {
		try {
			const { hasKey: present } = await nativeBridgeClient.scriptPolish.getKeyStatus();
			setHasKey(present);
		} catch (error) {
			console.warn("[useDocExport] key status failed:", error);
			setHasKey(false);
		}
	}, []);

	useEffect(() => {
		void refreshKeyStatus();
	}, [refreshKeyStatus]);

	const exportDoc = useCallback(async () => {
		try {
			const steps = deriveSteps(getDeriveInputs());
			if (steps.length === 0) {
				setStatus({ state: "error", message: "not-enough" });
				return;
			}
			const config = getScreenshotConfig();
			if (!config) {
				setStatus({ state: "error", message: "no-video" });
				return;
			}

			setStatus({ state: "capturing" });
			const shots = await captureStepScreenshots(
				config,
				steps.map((s) => s.screenshotMs),
			);

			setStatus({ state: "generating" });
			const stepInputs = steps.map((s, i) => ({
				id: s.id,
				transcriptText: s.transcriptText,
				imageDataUrl: shots[i],
			}));
			const res = await nativeBridgeClient.docExport.generate(stepInputs, {
				transcript: getFullTranscriptText(),
			});
			if (!res.success) {
				if (res.code === "no-key") setHasKey(false);
				setStatus({ state: "error", message: res.code ?? res.message ?? "generate-failed" });
				return;
			}

			const doc = validateGeneratedDoc(
				steps.map((s) => s.id),
				res.doc,
			);

			setStatus({ state: "rendering" });
			const byId = new Map(steps.map((s, i) => [s.id, shots[i]]));
			const html = renderDocHtml(doc, byId);

			setStatus({ state: "saving" });
			const saveRes = await nativeBridgeClient.docExport.save(html);
			if (saveRes.canceled) {
				setStatus({ state: "idle" });
				return;
			}
			if (!saveRes.success) {
				setStatus({ state: "error", message: saveRes.message ?? "save-failed" });
				return;
			}
			setStatus({ state: "idle" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[useDocExport] export failed:", message);
			setStatus({ state: "error", message });
		}
	}, [getDeriveInputs, getScreenshotConfig, getFullTranscriptText]);

	return { status, hasKey, refreshKeyStatus, exportDoc };
}
