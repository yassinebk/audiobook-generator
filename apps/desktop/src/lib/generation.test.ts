import { describe, expect, test, vi } from "vitest";
import { synthesizeChapter } from "./generation";

describe("synthesizeChapter", () => {
  test("synthesizes a whole chapter in one worker call before assembling", async () => {
    const worker = vi.fn(async (command: string) => {
      if (command === "synthesize_chapter_audio") {
        return { status: "succeeded", artifacts: [] };
      }
      if (command === "assemble_chapter_audio") {
        return { status: "succeeded", artifacts: [] };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await synthesizeChapter({
      scriptPath: "/tmp/book/scripts/chapter_001.json",
      segmentAudioDirectory: "/tmp/book/segments/chapter_001",
      outputPath: "/tmp/book/audio/chapter_001.wav",
      worker,
    });

    expect(worker).toHaveBeenCalledTimes(2);
    expect(worker).toHaveBeenNthCalledWith(1, "synthesize_chapter_audio", {
      scriptPath: "/tmp/book/scripts/chapter_001.json",
      outputDirectory: "/tmp/book/segments/chapter_001",
      backend: "parler",
      mergeSegments: true,
    });
    expect(worker).toHaveBeenNthCalledWith(2, "assemble_chapter_audio", {
      segmentAudioDirectory: "/tmp/book/segments/chapter_001",
      outputPath: "/tmp/book/audio/chapter_001.wav",
    });
  });
});
