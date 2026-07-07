import { useCallback, useEffect, useRef, useState } from "react";
import { computeTargetWords, resolveToneInstruction, validatePolishResults } from "@/lib/script";
import type { SegmentPolishStatus, VoiceoverConfig } from "@/lib/voiceover/types";
import { nativeBridgeClient } from "@/native/client";

export interface UseScriptPolishResult {
	statuses: Record<string, SegmentPolishStatus>;
	hasKey: boolean;
	secureStorageAvailable: boolean;
	refreshKeyStatus: () => Promise<void>;
	polishAll: () => Promise<void>;
	polishSegment: (id: string) => Promise<void>;
	revertSegment: (id: string) => void;
}

/**
 * Orchestrates AI script polishing. The script itself is undoable editor state (mutated via
 * `onChange`); per-segment polish status and the key-present flag are runtime-only. Results
 * are applied atomically (all-or-nothing) so the per-segment anchor/count invariant holds.
 */
export function useScriptPolish(params: {
	config: VoiceoverConfig;
	onChange: (updater: (prev: VoiceoverConfig) => VoiceoverConfig) => void;
}): UseScriptPolishResult {
	const { config, onChange } = params;
	const [statuses, setStatuses] = useState<Record<string, SegmentPolishStatus>>({});
	const [hasKey, setHasKey] = useState(false);
	const [secureStorageAvailable, setSecureStorageAvailable] = useState(true);

	const configRef = useRef(config);
	configRef.current = config;

	const refreshKeyStatus = useCallback(async () => {
		try {
			const { hasKey: present, secureStorageAvailable: secure } =
				await nativeBridgeClient.scriptPolish.getKeyStatus();
			setHasKey(present);
			setSecureStorageAvailable(secure);
		} catch (error) {
			console.warn("[useScriptPolish] key status failed:", error);
			setHasKey(false);
		}
	}, []);

	useEffect(() => {
		void refreshKeyStatus();
	}, [refreshKeyStatus]);

	const runPolish = useCallback(
		async (ids: string[]) => {
			const cfg = configRef.current;
			const targeted = cfg.segments.filter((s) => ids.includes(s.id) && s.text.trim().length > 0);
			if (targeted.length === 0) return;
			const inputs = targeted.map((s) => ({
				id: s.id,
				text: s.text,
				targetWords: computeTargetWords(s.sourceStartMs, s.sourceEndMs),
			}));
			setStatuses((prev) => {
				const next = { ...prev };
				for (const s of targeted) next[s.id] = { state: "polishing" };
				return next;
			});
			try {
				const res = await nativeBridgeClient.scriptPolish.polish(
					inputs,
					resolveToneInstruction(cfg.polishTone),
				);
				if (!res.success) {
					const message = res.code === "no-key" ? "no-key" : (res.message ?? "Polish failed.");
					if (res.code === "no-key") setHasKey(false);
					throw new Error(message);
				}
				const validated = validatePolishResults(
					inputs.map((i) => i.id),
					res.results,
				);
				const textById = new Map(validated.map((r) => [r.id, r.text]));
				onChange((prev) => ({
					...prev,
					segments: prev.segments.map((seg) => {
						const newText = textById.get(seg.id);
						if (newText === undefined) return seg;
						return { ...seg, textBeforePolish: seg.text, text: newText };
					}),
				}));
				setStatuses((prev) => {
					const next = { ...prev };
					for (const id of textById.keys()) next[id] = { state: "idle" };
					return next;
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn("[useScriptPolish] polish failed:", message);
				setStatuses((prev) => {
					const next = { ...prev };
					for (const s of targeted) next[s.id] = { state: "error", message };
					return next;
				});
			}
		},
		[onChange],
	);

	const polishAll = useCallback(
		() => runPolish(configRef.current.segments.map((s) => s.id)),
		[runPolish],
	);
	const polishSegment = useCallback((id: string) => runPolish([id]), [runPolish]);

	const revertSegment = useCallback(
		(id: string) => {
			onChange((prev) => ({
				...prev,
				segments: prev.segments.map((seg) => {
					if (seg.id !== id || seg.textBeforePolish === undefined) return seg;
					const { textBeforePolish, ...rest } = seg;
					return { ...rest, text: textBeforePolish };
				}),
			}));
			setStatuses((prev) => ({ ...prev, [id]: { state: "idle" } }));
		},
		[onChange],
	);

	return {
		statuses,
		hasKey,
		secureStorageAvailable,
		refreshKeyStatus,
		polishAll,
		polishSegment,
		revertSegment,
	};
}
