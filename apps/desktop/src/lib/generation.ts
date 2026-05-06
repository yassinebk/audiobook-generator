import { workerCall } from "./workerCall";

type WorkerCall = (
  command: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface SynthesizeChapterInput {
  scriptPath: string;
  segmentAudioDirectory: string;
  outputPath: string;
  worker?: WorkerCall;
}

export async function synthesizeChapter({
  scriptPath,
  segmentAudioDirectory,
  outputPath,
  worker = workerCall,
}: SynthesizeChapterInput): Promise<Record<string, unknown>> {
  await worker("synthesize_chapter_audio", {
    scriptPath,
    outputDirectory: segmentAudioDirectory,
    backend: "parler",
    mergeSegments: true,
  });

  return worker("assemble_chapter_audio", {
    segmentAudioDirectory,
    outputPath,
  });
}
