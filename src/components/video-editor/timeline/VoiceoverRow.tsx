import { useTimelineContext } from "dnd-timeline";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import { isAnchorTrimmed } from "@/lib/voiceover/layout";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import type { TrimRegion } from "../types";
import Row from "./Row";

export const VOICEOVER_ROW_ID = "row-voiceover";
const MIN_PILL_PX = 6;

export interface VoiceoverRowProps {
	segments: VoiceoverSegment[];
	statuses: Record<string, SegmentSynthStatus>;
	trimRegions: TrimRegion[];
	selectedSegmentId: string | null;
	onSelectSegment: (id: string) => void;
	hint: string;
	trimmedTitle: string;
}

/**
 * Read-only timeline lane for generated voiceover clips. The timeline axis is SOURCE time, so
 * clips are drawn at their source anchor with natural width; clips whose anchor falls in a trim
 * are dimmed (their words are cut). Output-time playback layout lives in layoutVoiceover (Plan 4).
 */
export function VoiceoverRow({
	segments,
	statuses,
	trimRegions,
	selectedSegmentId,
	onSelectSegment,
	hint,
	trimmedTitle,
}: VoiceoverRowProps) {
	const t = useScopedT("timeline");
	const { range, valueToPixels } = useTimelineContext();

	const pills = segments.flatMap((segment) => {
		const status = statuses[segment.id];
		if (!status || status.state !== "ready") return [];
		const left = valueToPixels(segment.sourceStartMs - range.start);
		const width = Math.max(MIN_PILL_PX, valueToPixels(status.durationMs));
		const trimmed = isAnchorTrimmed(segment.sourceStartMs, trimRegions);
		return [{ segment, left, width, trimmed }];
	});

	return (
		<Row id={VOICEOVER_ROW_ID} isEmpty={pills.length === 0} hint={hint}>
			{pills.map(({ segment, left, width, trimmed }) => (
				<button
					key={segment.id}
					type="button"
					data-testid="voiceover-clip"
					title={trimmed ? trimmedTitle : undefined}
					onClick={(event) => {
						event.stopPropagation();
						onSelectSegment(segment.id);
					}}
					style={{ position: "absolute", left, width, top: 3, height: 30 }}
					className={cn(
						"z-10 flex items-center overflow-hidden rounded-md border px-2 text-[10px] font-medium text-white/90 transition-opacity",
						"border-[#34B27B]/40 bg-[#34B27B]/20",
						trimmed && "opacity-40 grayscale",
						selectedSegmentId === segment.id && "ring-1 ring-[#34B27B]",
					)}
				>
					<span className="truncate">{segment.text || t("labels.trim")}</span>
				</button>
			))}
		</Row>
	);
}
