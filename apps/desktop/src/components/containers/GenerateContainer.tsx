import type {
  AnalysisState,
  BookState,
  PipelineStage,
  ProgressDetail,
} from "../../types";
import { Step4Generate } from "../steps/Step4Generate";

interface GenerateContainerProps {
  book: BookState;
  analysis: AnalysisState;
  selectedChapters: Set<string>;
  correctionDirty: boolean;
  chapterAudioPaths: Record<string, string>;
  stage: PipelineStage;
  isBusy: boolean;
  analyzeProgress: string;
  progressDetail: ProgressDetail[];
  progress: number;
  onGenerate: () => void;
  onContinue: () => void;
}

export function GenerateContainer({
  book,
  analysis,
  selectedChapters,
  correctionDirty,
  chapterAudioPaths,
  stage,
  isBusy,
  analyzeProgress,
  progressDetail,
  progress,
  onGenerate,
  onContinue,
}: GenerateContainerProps) {
  return (
    <Step4Generate
      book={book}
      analysis={analysis}
      selectedChapters={selectedChapters}
      correctionDirty={correctionDirty}
      chapterAudioPaths={chapterAudioPaths}
      isBusy={isBusy}
      isGenerating={stage === "generating"}
      analyzeProgress={analyzeProgress}
      progressDetail={progressDetail}
      progress={progress}
      onGenerate={onGenerate}
      onContinue={onContinue}
    />
  );
}
