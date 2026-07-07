import { type FrameRenderConfig, FrameRenderer } from "@/lib/exporter/frameRenderer";
import { StreamingVideoDecoder } from "@/lib/exporter/streamingDecoder";

const SCREENSHOT_MAX_W = 1440;

export type DocScreenshotConfig = Omit<FrameRenderConfig, "videoWidth" | "videoHeight"> & {
	videoUrl: string;
	frameRate: number;
};

function canvasToDataUrl(canvas: HTMLCanvasElement, maxW: number): string {
	const scale = canvas.width > maxW ? maxW / canvas.width : 1;
	if (scale === 1) return canvas.toDataURL("image/png");
	const out = document.createElement("canvas");
	out.width = Math.round(canvas.width * scale);
	out.height = Math.round(canvas.height * scale);
	const ctx = out.getContext("2d");
	if (!ctx) return canvas.toDataURL("image/png");
	ctx.drawImage(canvas, 0, 0, out.width, out.height);
	return out.toDataURL("image/png");
}

/**
 * Capture a composited screenshot (cursor/zoom/annotations baked in) at each timestamp,
 * by a single linear decode pass over the video — no random-access seeking. Results are
 * returned as PNG data URLs aligned to `timesMs` order.
 */
export async function captureStepScreenshots(
	config: DocScreenshotConfig,
	timesMs: number[],
): Promise<string[]> {
	if (timesMs.length === 0) return [];
	const targets = [...timesMs].sort((a, b) => a - b);
	const results: string[] = new Array(targets.length).fill("");

	const decoder = new StreamingVideoDecoder();
	const info = await decoder.loadMetadata(config.videoUrl);
	const renderer = new FrameRenderer({
		...config,
		videoWidth: info.width,
		videoHeight: info.height,
	} as FrameRenderConfig);
	await renderer.initialize();

	let idx = 0;
	let last = "";
	await decoder.decodeAll(config.frameRate, [], [], async (frame, _exportTsUs, sourceMs) => {
		try {
			if (idx < targets.length && sourceMs >= targets[idx]) {
				await renderer.renderFrame(frame, sourceMs * 1000, null);
				last = canvasToDataUrl(renderer.getCanvas(), SCREENSHOT_MAX_W);
				while (idx < targets.length && sourceMs >= targets[idx]) {
					results[idx] = last;
					idx++;
				}
			}
		} finally {
			frame.close();
		}
	});

	// Targets past the final frame → fall back to the last rendered frame.
	for (let i = 0; i < results.length; i++) {
		if (!results[i]) results[i] = last;
	}
	return results;
}
