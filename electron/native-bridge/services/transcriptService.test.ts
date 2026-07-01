import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptService } from "./transcriptService";

let root: string;
let videoPath: string;
let service: TranscriptService;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "transcript-svc-"));
	videoPath = path.join(root, "video.mp4");
	await writeFile(videoPath, "fake-video-bytes");
	service = new TranscriptService({
		cacheDir: path.join(root, "transcripts"),
		draftsDir: path.join(root, "caption-drafts"),
		resolveSourcePath: (p) => p,
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("TranscriptService", () => {
	it("returns success with no transcript on a cache miss", async () => {
		const res = await service.getTranscript(videoPath);
		expect(res.success).toBe(true);
		expect(res.transcript).toBeUndefined();
	});

	it("round-trips a stored transcript", async () => {
		const transcript = {
			segments: [{ startSec: 0, endSec: 1, text: "hi" }],
			model: "whisper-tiny",
		};
		await service.putTranscript(videoPath, transcript);
		const res = await service.getTranscript(videoPath);
		expect(res.transcript).toEqual(transcript);
	});

	it("invalidates the cache when the video bytes change", async () => {
		await service.putTranscript(videoPath, { segments: [], model: "whisper-tiny" });
		await writeFile(videoPath, "different-and-longer-bytes");
		const res = await service.getTranscript(videoPath);
		expect(res.transcript).toBeUndefined();
	});

	it("round-trips and clears a caption draft", async () => {
		const regions = [{ id: "annotation-1", type: "text", content: "hi" }];
		await service.putCaptionDraft(videoPath, regions);
		expect((await service.getCaptionDraft(videoPath)).regions).toEqual(regions);
		await service.clearCaptionDraft(videoPath);
		expect((await service.getCaptionDraft(videoPath)).regions).toBeUndefined();
	});
});
