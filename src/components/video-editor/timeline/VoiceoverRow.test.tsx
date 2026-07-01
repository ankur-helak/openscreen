import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("dnd-timeline", () => ({
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock noop
	useRow: () => ({ setNodeRef: () => {}, rowWrapperStyle: {}, rowStyle: { position: "relative" } }),
	useTimelineContext: () => ({
		range: { start: 0, end: 10000 },
		valueToPixels: (ms: number) => ms / 10,
	}),
}));

import { I18nProvider } from "@/contexts/I18nContext";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import { VoiceoverRow } from "./VoiceoverRow";

const segments: VoiceoverSegment[] = [
	{ id: "vo-1", sourceStartMs: 2000, sourceEndMs: 3000, text: "a" },
	{ id: "vo-2", sourceStartMs: 5000, sourceEndMs: 6000, text: "b" },
];
const statuses: Record<string, SegmentSynthStatus> = {
	"vo-1": { state: "ready", audioKey: "k1", durationMs: 1000 },
	"vo-2": { state: "ready", audioKey: "k2", durationMs: 1000 },
};

function renderRow(props: React.ComponentProps<typeof VoiceoverRow>) {
	return render(
		<I18nProvider>
			<VoiceoverRow {...props} />
		</I18nProvider>,
	);
}

describe("VoiceoverRow", () => {
	it("renders one pill per ready segment, positioned by source anchor", () => {
		renderRow({
			segments,
			statuses,
			trimRegions: [],
			selectedSegmentId: null,
			onSelectSegment: vi.fn(),
			hint: "hint",
			trimmedTitle: "trimmed",
		});
		const pills = screen.getAllByTestId("voiceover-clip");
		expect(pills).toHaveLength(2);
		// valueToPixels(2000) = 200
		expect(pills[0].style.left).toBe("200px");
		expect(pills[0].style.width).toBe("100px");
	});

	it("does not render pills for non-ready segments", () => {
		renderRow({
			segments,
			statuses: { "vo-1": { state: "idle" }, "vo-2": statuses["vo-2"] },
			trimRegions: [],
			selectedSegmentId: null,
			onSelectSegment: vi.fn(),
			hint: "hint",
			trimmedTitle: "trimmed",
		});
		expect(screen.getAllByTestId("voiceover-clip")).toHaveLength(1);
	});

	it("marks a trimmed clip and still renders it, and selecting a pill fires the callback", () => {
		const onSelect = vi.fn();
		renderRow({
			segments,
			statuses,
			trimRegions: [{ id: "t1", startMs: 4500, endMs: 6000 }],
			selectedSegmentId: null,
			onSelectSegment: onSelect,
			hint: "hint",
			trimmedTitle: "trimmed",
		});
		const pills = screen.getAllByTestId("voiceover-clip");
		expect(pills).toHaveLength(2);
		expect(pills[1].getAttribute("title")).toBe("trimmed");
		fireEvent.click(pills[0]);
		expect(onSelect).toHaveBeenCalledWith("vo-1");
	});
});
