import { describe, expect, test } from "vitest";
import { generationProgressDetails } from "./generationProgress";

describe("generationProgressDetails", () => {
  test("computes elapsed from the current clock value", () => {
    const details = generationProgressDetails({
      now: 7_500,
      startTime: 1_000,
      doneSegments: 2,
      totalSegments: 6,
      chapterIndex: 1,
      chapterCount: 3,
      segmentCount: 10,
    });

    expect(details).toContainEqual({ label: "Elapsed", value: "7s" });
    expect(details).toContainEqual({ label: "ETA", value: "~14s" });
  });
});
