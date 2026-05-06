import type { AnalysisState, BookState, ChapterMeta } from "../../types";
import { StepDone } from "../steps/StepDone";

interface DoneContainerProps {
  book: BookState;
  chapterAudioPaths: Record<string, string>;
  analysis: AnalysisState | null;
  savedMessage: string | null;
  isBusy: boolean;
  onSaveChapter: (chapter: ChapterMeta) => void;
  onRegenerateChapter: (chapter: ChapterMeta) => void;
  onRegenerateAll: () => void;
}

export function DoneContainer({
  book,
  chapterAudioPaths,
  analysis,
  savedMessage,
  isBusy,
  onSaveChapter,
  onRegenerateChapter,
  onRegenerateAll,
}: DoneContainerProps) {
  return (
    <StepDone
      book={book}
      chapterAudioPaths={chapterAudioPaths}
      analysis={analysis}
      savedMessage={savedMessage}
      isBusy={isBusy}
      onSaveChapter={onSaveChapter}
      onRegenerateChapter={onRegenerateChapter}
      onRegenerateAll={onRegenerateAll}
    />
  );
}
