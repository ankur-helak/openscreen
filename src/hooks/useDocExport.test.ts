import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeriveStepsInput } from "@/lib/docExport/types";
import { useDocExport } from "./useDocExport";

vi.mock("@/lib/docExport/screenshots", () => ({
	captureStepScreenshots: vi.fn(async (_config, times: number[]) =>
		times.map((_, i) => `data:image/png;base64,SHOT${i}`),
	),
}));

const generate = vi.fn();
const save = vi.fn();
const getKeyStatus = vi.fn(async () => ({ hasKey: true }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		docExport: {
			generate: (...a: unknown[]) => generate(...a),
			save: (...a: unknown[]) => save(...a),
		},
		scriptPolish: { getKeyStatus: () => getKeyStatus() },
	},
}));

const inputs: DeriveStepsInput = {
	clicks: [100, 5000],
	zoomStarts: [],
	annotationStarts: [],
	narration: [
		{ sourceStartMs: 0, sourceEndMs: 900, text: "Open the board." },
		{ sourceStartMs: 5000, sourceEndMs: 5900, text: "Create a ticket." },
	],
	endMs: 6000,
	coalesceMs: 1500,
};

const params = {
	hasTranscript: true,
	getFullTranscriptText: () => "full transcript",
	getDeriveInputs: () => inputs,
	getScreenshotConfig: () => ({ videoUrl: "x", frameRate: 15 }) as never,
};

beforeEach(() => {
	generate.mockReset();
	save.mockReset();
});

describe("useDocExport", () => {
	it("runs capture → generate → render → save on success", async () => {
		generate.mockResolvedValue({
			success: true,
			doc: {
				title: "T",
				overview: "O",
				audience: ["a"],
				learn: ["l"],
				steps: [
					{ id: "step-1", heading: "H1", body: "B1 **bold**" },
					{ id: "step-2", heading: "H2", body: "B2" },
				],
			},
		});
		save.mockResolvedValue({ success: true, path: "/tmp/walkthrough.html" });

		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});

		expect(generate).toHaveBeenCalledTimes(1);
		const [sentSteps] = generate.mock.calls[0];
		expect(sentSteps).toHaveLength(2);
		expect(sentSteps[0].imageDataUrl).toBe("data:image/png;base64,SHOT0");
		const [html] = save.mock.calls[0];
		expect(html).toContain("<strong>"); // rendered doc
		expect(result.current.status.state).toBe("idle");
	});

	it("aborts atomically on an id-set mismatch (no save)", async () => {
		generate.mockResolvedValue({
			success: true,
			doc: {
				title: "T",
				overview: "O",
				audience: ["a"],
				learn: ["l"],
				steps: [{ id: "step-1", heading: "H", body: "B" }], // missing step-2
			},
		});
		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});
		expect(save).not.toHaveBeenCalled();
		expect(result.current.status.state).toBe("error");
	});

	it("surfaces no-key without saving", async () => {
		generate.mockResolvedValue({ success: false, code: "no-key" });
		const { result } = renderHook(() => useDocExport(params));
		await act(async () => {
			await result.current.exportDoc();
		});
		expect(save).not.toHaveBeenCalled();
		await waitFor(() => expect(result.current.hasKey).toBe(false));
	});
});
