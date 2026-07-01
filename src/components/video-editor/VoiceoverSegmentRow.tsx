import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";

export interface VoiceoverSegmentRowProps {
	segment: VoiceoverSegment;
	status: SegmentSynthStatus;
	isSelected: boolean;
	isAuditioning: boolean;
	canGenerate: boolean;
	onTextChange: (text: string) => void;
	onTextCommit: () => void;
	onGenerate: () => void;
	onAudition: () => void;
	onStopAudition: () => void;
	onSelect: () => void;
}

function formatAnchor(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function VoiceoverSegmentRow({
	segment,
	status,
	isSelected,
	isAuditioning,
	canGenerate,
	onTextChange,
	onTextCommit,
	onGenerate,
	onAudition,
	onStopAudition,
	onSelect,
}: VoiceoverSegmentRowProps) {
	const t = useScopedT("voiceover");
	const isReady = status.state === "ready";
	const isBusy = status.state === "synthesizing" || status.state === "queued";
	const statusLabel = t(`status.${status.state}`);

	return (
		<div
			onPointerDownCapture={onSelect}
			className={cn(
				"rounded-lg border p-2 transition-colors",
				isSelected
					? "border-[#34B27B]/50 bg-[#34B27B]/[0.06]"
					: "border-white/[0.06] bg-white/[0.02] hover:border-white/10",
			)}
		>
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<span className="text-[10px] font-semibold tabular-nums text-slate-500">
					{formatAnchor(segment.sourceStartMs)}
				</span>
				<span
					className={cn(
						"rounded-full px-2 py-0.5 text-[10px] font-semibold",
						status.state === "error"
							? "bg-red-500/15 text-red-300"
							: isReady
								? "bg-[#34B27B]/15 text-[#34B27B]"
								: "bg-white/5 text-slate-400",
					)}
				>
					{statusLabel}
				</span>
			</div>

			<textarea
				value={segment.text}
				placeholder={t("textPlaceholder")}
				onChange={(e) => onTextChange(e.target.value)}
				onBlur={onTextCommit}
				rows={2}
				className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-[#34B27B]/50"
			/>

			<div className="mt-1.5 flex items-center gap-1.5">
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={!canGenerate || isBusy}
					onClick={onGenerate}
					className="h-7 gap-1 px-2 text-[11px]"
				>
					{isBusy ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<RefreshCw className="h-3 w-3" />
					)}
					{t("regenerate")}
				</Button>
				{isReady &&
					(isAuditioning ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onStopAudition}
							className="h-7 gap-1 px-2 text-[11px]"
						>
							<Square className="h-3 w-3" />
							{t("stop")}
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onAudition}
							className="h-7 gap-1 px-2 text-[11px]"
						>
							<Play className="h-3 w-3" />
							{t("play")}
						</Button>
					))}
			</div>
		</div>
	);
}
