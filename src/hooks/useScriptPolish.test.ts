import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceoverConfig } from "@/lib/voiceover/types";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		scriptPolish: {
			polish: vi.fn(),
			getKeyStatus: vi.fn(async () => ({ hasKey: true })),
		},
	},
}));

import { nativeBridgeClient } from "@/native/client";
import { useScriptPolish } from "./useScriptPolish";

const { polish, getKeyStatus } = nativeBridgeClient.scriptPolish;

function baseConfig(): VoiceoverConfig {
	return {
		enabled: true,
		engine: "kokoro-local",
		voice: "af_heart",
		speed: 1,
		polishTone: "concise",
		segments: [
			{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 2000, text: "uh hi" },
			{ id: "vo-2", sourceStartMs: 2000, sourceEndMs: 4000, text: "um bye" },
		],
	};
}

beforeEach(() => {
	polish.mockReset();
	getKeyStatus.mockClear();
});

describe("useScriptPolish", () => {
	it("applies polished text and snapshots textBeforePolish for each segment", async () => {
		polish.mockResolvedValue({
			success: true,
			results: [
				{ id: "vo-1", text: "Hi." },
				{ id: "vo-2", text: "Bye." },
			],
		});
		let cfg = baseConfig();
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		await act(async () => {
			await result.current.polishAll();
		});
		expect(cfg.segments[0]).toMatchObject({ text: "Hi.", textBeforePolish: "uh hi" });
		expect(cfg.segments[1]).toMatchObject({ text: "Bye.", textBeforePolish: "um bye" });
	});

	it("applies nothing and marks segments error on a failed/invalid response", async () => {
		polish.mockResolvedValue({ success: true, results: [{ id: "vo-1", text: "only one" }] });
		let cfg = baseConfig();
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		await act(async () => {
			await result.current.polishAll();
		});
		expect(onChange).not.toHaveBeenCalled(); // id-set mismatch → atomic no-op
		expect(result.current.statuses["vo-1"].state).toBe("error");
	});

	it("reverts a segment to its pre-polish text and clears the snapshot", () => {
		let cfg = baseConfig();
		cfg.segments[0] = { ...cfg.segments[0], text: "Hi.", textBeforePolish: "uh hi" };
		const onChange = vi.fn((u: (p: VoiceoverConfig) => VoiceoverConfig) => {
			cfg = u(cfg);
		});
		const { result } = renderHook(() => useScriptPolish({ config: cfg, onChange }));
		act(() => result.current.revertSegment("vo-1"));
		expect(cfg.segments[0].text).toBe("uh hi");
		expect(cfg.segments[0].textBeforePolish).toBeUndefined();
	});

	it("surfaces no-key by reporting hasKey=false", async () => {
		getKeyStatus.mockResolvedValueOnce({ hasKey: false });
		const { result } = renderHook(() =>
			useScriptPolish({ config: baseConfig(), onChange: vi.fn() }),
		);
		await waitFor(() => expect(result.current.hasKey).toBe(false));
	});
});
