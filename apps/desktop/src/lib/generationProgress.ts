import type { ProgressDetail } from "../types";

export function generationProgressDetails({
  now,
  startTime,
  doneSegments,
  totalSegments,
  chapterIndex,
  chapterCount,
  segmentCount,
}: {
  now: number;
  startTime: number;
  doneSegments: number;
  totalSegments: number;
  chapterIndex: number;
  chapterCount: number;
  segmentCount: number;
}): ProgressDetail[] {
  const elapsed = Math.round((now - startTime) / 1000);
  const avgPerSeg = doneSegments > 0 ? elapsed / doneSegments : 8;
  const remaining = Math.round(avgPerSeg * Math.max(totalSegments - doneSegments, 0));

  return [
    { label: "Backend", value: "Parler TTS (MPS)" },
    { label: "Chapter", value: `${chapterIndex} of ${chapterCount}` },
    { label: "Segments", value: String(segmentCount) },
    { label: "Elapsed", value: `${elapsed}s` },
    { label: "ETA", value: `~${remaining}s` },
  ];
}
