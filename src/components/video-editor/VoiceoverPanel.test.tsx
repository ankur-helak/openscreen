import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { DEFAULT_VOICEOVER_CONFIG, type VoiceoverConfig } from "@/lib/voiceover/types";
import { VoiceoverPanel, type VoiceoverPanelProps } from "./VoiceoverPanel";

// Mock ResizeObserver for Radix UI Slider
global.ResizeObserver = class ResizeObserver {
	observe() {
		/* stub */
	}
	unobserve() {
		/* stub */
	}
	disconnect() {
		/* stub */
	}
};

function baseProps(overrides: Partial<VoiceoverPanelProps> = {}): VoiceoverPanelProps {
	const config: VoiceoverConfig = {
		...DEFAULT_VOICEOVER_CONFIG,
		enabled: true,
		segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "hello" }],
	};
	return {
		config,
		statuses: { "vo-1": { state: "idle" } },
		clips: {},
		audioKeyFor: () => "k1",
		transcriptReady: true,
		hasTranscript: true,
		selectedSegmentId: null,
		onToggleEnabled: vi.fn(),
		onVoiceChange: vi.fn(),
		onSpeedChange: vi.fn(),
		onSpeedCommit: vi.fn(),
		onSegmentTextChange: vi.fn(),
		onSegmentTextCommit: vi.fn(),
		onGenerateSegment: vi.fn(),
		onGenerateAll: vi.fn(),
		onResetScript: vi.fn(),
		onSelectSegment: vi.fn(),
		polishStatuses: {},
		hasOpenAiKey: false,
		onPolishTone: vi.fn(),
		onPolishAll: vi.fn(),
		onPolishSegment: vi.fn(),
		onRevertSegment: vi.fn(),
		onOpenKeyDialog: vi.fn(),
		...overrides,
	};
}

function renderPanel(props: VoiceoverPanelProps) {
	render(
		<I18nProvider>
			<VoiceoverPanel {...props} />
		</I18nProvider>,
	);
}

describe("VoiceoverPanel", () => {
	it("renders one row per segment and fires Generate all", () => {
		const props = baseProps();
		renderPanel(props);
		expect(screen.getByDisplayValue("hello")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /generate all/i }));
		expect(props.onGenerateAll).toHaveBeenCalled();
	});

	it("shows a transcribing hint and hides the script when transcript is not ready", () => {
		const props = baseProps({
			transcriptReady: false,
			hasTranscript: false,
			config: { ...DEFAULT_VOICEOVER_CONFIG, enabled: true, segments: [] },
			statuses: {},
		});
		renderPanel(props);
		expect(screen.getByText(/record or open a video|transcrib/i)).toBeInTheDocument();
	});

	it("routes per-segment text edits through onSegmentTextChange", () => {
		const props = baseProps();
		renderPanel(props);
		fireEvent.change(screen.getByDisplayValue("hello"), { target: { value: "hi" } });
		expect(props.onSegmentTextChange).toHaveBeenCalledWith("vo-1", "hi");
	});
});
