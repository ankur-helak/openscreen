import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "./types";

describe("DEFAULT_CAPTION_SETTINGS", () => {
	it("matches the legacy auto-caption look and default word bounds", () => {
		expect(DEFAULT_CAPTION_SETTINGS.style).toEqual({
			color: "#ffffff",
			backgroundColor: "rgba(255, 255, 255, 0)",
			fontSize: 24,
			fontFamily: "Inter",
			fontWeight: "normal",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		});
		expect(DEFAULT_CAPTION_SETTINGS.position).toEqual({ x: 4, y: 86 });
		expect(DEFAULT_CAPTION_SETTINGS.size).toEqual({ width: 92, height: 12 });
		expect(DEFAULT_CAPTION_SETTINGS.minWords).toBe(2);
		expect(DEFAULT_CAPTION_SETTINGS.maxWords).toBe(7);
	});
});
