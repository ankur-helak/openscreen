import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
import { captureStepScreenshots } from "./screenshots";

describe("captureStepScreenshots (real browser)", () => {
	it("returns one PNG data URL per requested timestamp", async () => {
		const shots = await captureStepScreenshots(
			{
				videoUrl: sampleVideoUrl,
				frameRate: 15,
				width: 320,
				height: 180,
				wallpaper: "#1a1a2e",
				zoomRegions: [],
				showShadow: false,
				shadowIntensity: 0,
				showBlur: false,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				// gl.readPixels readback path — deterministic, non-blank pixels in headless Chromium.
				platform: "linux",
			},
			[0, 300],
		);

		expect(shots).toHaveLength(2);
		for (const url of shots) {
			expect(url.startsWith("data:image/png;base64,")).toBe(true);
			expect(url.length).toBeGreaterThan(1024); // non-trivial image
		}
	});
});
