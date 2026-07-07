import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import { VoiceoverSegmentRow } from "./VoiceoverSegmentRow";

const segment: VoiceoverSegment = {
	id: "vo-1",
	sourceStartMs: 2000,
	sourceEndMs: 3000,
	text: "hello",
};

function renderRow(overrides: Partial<React.ComponentProps<typeof VoiceoverSegmentRow>> = {}) {
	const props = {
		segment,
		status: { state: "idle" } as SegmentSynthStatus,
		polishStatus: { state: "idle" },
		isSelected: false,
		isAuditioning: false,
		canGenerate: true,
		onTextChange: vi.fn(),
		onTextCommit: vi.fn(),
		onGenerate: vi.fn(),
		onAudition: vi.fn(),
		onStopAudition: vi.fn(),
		onSelect: vi.fn(),
		onPolish: vi.fn(),
		onRevert: vi.fn(),
		...overrides,
	};
	render(
		<I18nProvider>
			<VoiceoverSegmentRow {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("VoiceoverSegmentRow", () => {
	it("renders the editable text and fires change + commit", () => {
		const props = renderRow();
		const field = screen.getByDisplayValue("hello");
		fireEvent.change(field, { target: { value: "hi there" } });
		expect(props.onTextChange).toHaveBeenCalledWith("hi there");
		fireEvent.blur(field);
		expect(props.onTextCommit).toHaveBeenCalled();
	});

	it("shows a Generate action when idle and calls onGenerate", () => {
		const props = renderRow({ status: { state: "idle" } });
		fireEvent.click(screen.getByRole("button", { name: /generate|regenerate/i }));
		expect(props.onGenerate).toHaveBeenCalled();
	});

	it("shows an audition button only when the clip is ready", () => {
		const { rerender } = render(
			<I18nProvider>
				<VoiceoverSegmentRow
					segment={segment}
					status={{ state: "idle" }}
					polishStatus={{ state: "idle" }}
					isSelected={false}
					isAuditioning={false}
					canGenerate
					onTextChange={vi.fn()}
					onTextCommit={vi.fn()}
					onGenerate={vi.fn()}
					onAudition={vi.fn()}
					onStopAudition={vi.fn()}
					onSelect={vi.fn()}
					onPolish={vi.fn()}
					onRevert={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
		rerender(
			<I18nProvider>
				<VoiceoverSegmentRow
					segment={segment}
					status={{ state: "ready", audioKey: "k1", durationMs: 900 }}
					polishStatus={{ state: "idle" }}
					isSelected={false}
					isAuditioning={false}
					canGenerate
					onTextChange={vi.fn()}
					onTextCommit={vi.fn()}
					onGenerate={vi.fn()}
					onAudition={vi.fn()}
					onStopAudition={vi.fn()}
					onSelect={vi.fn()}
					onPolish={vi.fn()}
					onRevert={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
	});
});
