import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_SETTINGS } from "@/components/video-editor/types";
import { INITIAL_EDITOR_STATE } from "./useEditorHistory";

describe("INITIAL_EDITOR_STATE.captions", () => {
	it("defaults to the global caption settings", () => {
		expect(INITIAL_EDITOR_STATE.captions).toEqual(DEFAULT_CAPTION_SETTINGS);
	});
});
