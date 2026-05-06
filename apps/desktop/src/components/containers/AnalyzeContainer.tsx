import type {
  AnalysisState,
  BookState,
  PipelineStage,
  ProgressDetail,
  RightsResult,
} from "../../types";
import { Step2Analyze } from "../steps/Step2Analyze";

interface AnalyzeContainerProps {
  book: BookState;
  analysis: AnalysisState | null;
  rights: RightsResult | null;
  rightsAttested: boolean;
  stage: PipelineStage;
  isBusy: boolean;
  selectedChapters: Set<string>;
  chapterStatuses: Record<string, string>;
  analyzeProgress: string;
  progressDetail: ProgressDetail[];
  progress: number;
  onAnalyze: () => void;
  onToggleChapter: (id: string) => void;
  onToggleAll: () => void;
  onContinue: () => void;
}

export function AnalyzeContainer({
  book,
  analysis,
  rights,
  rightsAttested,
  stage,
  isBusy,
  selectedChapters,
  chapterStatuses,
  analyzeProgress,
  progressDetail,
  progress,
  onAnalyze,
  onToggleChapter,
  onToggleAll,
  onContinue,
}: AnalyzeContainerProps) {
  return (
    <Step2Analyze
      book={book}
      analysis={analysis}
      rights={rights}
      rightsAttested={rightsAttested}
      isBusy={isBusy}
      isAnalyzing={stage === "analyzing"}
      selectedChapters={selectedChapters}
      chapterStatuses={chapterStatuses}
      analyzeProgress={analyzeProgress}
      progressDetail={progressDetail}
      progress={progress}
      onAnalyze={onAnalyze}
      onToggleChapter={onToggleChapter}
      onToggleAll={onToggleAll}
      onContinue={onContinue}
    />
  );
}
