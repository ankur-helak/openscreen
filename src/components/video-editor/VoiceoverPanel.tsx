import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import { useClipAudition } from "@/hooks/useClipAudition";
import type { ResolvedClip } from "@/hooks/useVoiceover";
import { KOKORO_VOICES } from "@/lib/tts/voices";
import { cn } from "@/lib/utils";
import type { SegmentSynthStatus, VoiceoverConfig, VoiceoverSegment } from "@/lib/voiceover/types";
import { VoiceoverSegmentRow } from "./VoiceoverSegmentRow";

const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;
const SPEED_STEP = 0.05;

export interface VoiceoverPanelProps {
	config: VoiceoverConfig;
	statuses: Record<string, SegmentSynthStatus>;
	clips: Record<string, ResolvedClip>;
	audioKeyFor: (segment: VoiceoverSegment) => string;
	transcriptReady: boolean;
	hasTranscript: boolean;
	selectedSegmentId: string | null;
	onToggleEnabled: (enabled: boolean) => void;
	onVoiceChange: (voice: string) => void;
	onSpeedChange: (speed: number) => void;
	onSpeedCommit: () => void;
	onSegmentTextChange: (id: string, text: string) => void;
	onSegmentTextCommit: () => void;
	onGenerateSegment: (id: string) => void;
	onGenerateAll: () => void;
	onResetScript: () => void;
	onSelectSegment: (id: string) => void;
}

export function VoiceoverPanel({
	config,
	statuses,
	clips,
	audioKeyFor,
	transcriptReady,
	hasTranscript,
	selectedSegmentId,
	onToggleEnabled,
	onVoiceChange,
	onSpeedChange,
	onSpeedCommit,
	onSegmentTextChange,
	onSegmentTextCommit,
	onGenerateSegment,
	onGenerateAll,
	onResetScript,
	onSelectSegment,
}: VoiceoverPanelProps) {
	const t = useScopedT("voiceover");
	const audition = useClipAudition();
	const { segments } = config;

	const readyCount = useMemo(
		() => segments.filter((s) => statuses[s.id]?.state === "ready").length,
		[segments, statuses],
	);
	const isGenerating = segments.some((s) => {
		const st = statuses[s.id]?.state;
		return st === "synthesizing" || st === "queued";
	});

	return (
		<div className="flex min-w-0 flex-col gap-3 px-1">
			<p className="text-[11px] leading-relaxed text-slate-500">{t("description")}</p>

			{/* Enable toggle */}
			<div className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
				<div className="min-w-0">
					<div className="text-xs font-semibold text-slate-100">{t("enableLabel")}</div>
					<div className="mt-0.5 text-[10px] leading-snug text-slate-500">{t("enableHint")}</div>
				</div>
				<Switch checked={config.enabled} onCheckedChange={onToggleEnabled} />
			</div>

			{/* Voice + speed */}
			<div className="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
				<div>
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
						{t("voiceLabel")}
					</div>
					<Select value={config.voice} onValueChange={onVoiceChange}>
						<SelectTrigger className="h-8 border-white/10 bg-black/20 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{KOKORO_VOICES.map((v) => (
								<SelectItem key={v.id} value={v.id} className="text-xs">
									{v.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div>
					<div className="mb-1 flex items-center justify-between">
						<span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
							{t("speedLabel")}
						</span>
						<span className="text-[11px] tabular-nums text-slate-300">
							{config.speed.toFixed(2)}×
						</span>
					</div>
					<Slider
						value={[config.speed]}
						min={SPEED_MIN}
						max={SPEED_MAX}
						step={SPEED_STEP}
						onValueChange={(values) => onSpeedChange(values[0])}
						onValueCommit={onSpeedCommit}
					/>
				</div>
			</div>

			{/* Generate all + reset */}
			<div className="flex items-center gap-1.5">
				<Button
					type="button"
					size="sm"
					disabled={!transcriptReady || segments.length === 0 || isGenerating}
					onClick={onGenerateAll}
					className="h-8 flex-1 gap-1.5 text-xs"
				>
					{isGenerating ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Sparkles className="h-3.5 w-3.5" />
					)}
					{isGenerating
						? t("generating", { done: readyCount, total: segments.length })
						: t("generateAll")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={!transcriptReady || !hasTranscript}
					onClick={onResetScript}
					title={t("resetScript")}
					className="h-8 gap-1 px-2 text-xs"
				>
					<RotateCcw className="h-3.5 w-3.5" />
				</Button>
			</div>

			{/* Body */}
			{!hasTranscript ? (
				<EmptyHint text={t("noTranscript")} />
			) : !transcriptReady ? (
				<EmptyHint text={t("transcribing")} />
			) : segments.length === 0 ? (
				<EmptyHint text={t("noSegments")} />
			) : (
				<div className="flex flex-col gap-2">
					{segments.map((segment) => {
						const status = statuses[segment.id] ?? { state: "idle" };
						const key = status.state === "ready" ? status.audioKey : audioKeyFor(segment);
						const clip = clips[key];
						return (
							<VoiceoverSegmentRow
								key={segment.id}
								segment={segment}
								status={status}
								isSelected={selectedSegmentId === segment.id}
								isAuditioning={audition.auditioningKey === key}
								canGenerate={transcriptReady}
								onTextChange={(text) => onSegmentTextChange(segment.id, text)}
								onTextCommit={onSegmentTextCommit}
								onGenerate={() => onGenerateSegment(segment.id)}
								onAudition={() => clip && audition.play(clip, key)}
								onStopAudition={audition.stop}
								onSelect={() => onSelectSegment(segment.id)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

function EmptyHint({ text }: { text: string }) {
	return (
		<div className={cn("rounded-lg border border-dashed border-white/[0.08] p-4")}>
			<p className="text-center text-[11px] leading-relaxed text-slate-500">{text}</p>
		</div>
	);
}
