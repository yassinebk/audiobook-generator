import { convertFileSrc } from "@tauri-apps/api/core";
import type { AnalysisState, BookState, ChapterMeta } from "../../types";

interface StepDoneProps {
  book: BookState;
  chapterAudioPaths: Record<string, string>;
  analysis: AnalysisState | null;
  savedMessage: string | null;
  onSaveChapter: (chapter: ChapterMeta) => void;
}

export function StepDone({
  book,
  chapterAudioPaths,
  analysis,
  savedMessage,
  onSaveChapter,
}: StepDoneProps) {
  const generatedChapters = book.chapters.filter((c) => chapterAudioPaths[c.id]);

  return (
    <div className="step-workspace visible" aria-label="Done: Listen">
      <header className="step-header">
        <div className="done-banner">
          <span className="done-checkmark">✓</span>
          <div>
            <h2>Audiobook Ready</h2>
            <p className="step-desc">
              {generatedChapters.length} chapter
              {generatedChapters.length !== 1 ? "s" : ""} synthesized.
            </p>
          </div>
        </div>
        <div className="done-stats">
          <div className="done-stat">
            <span className="done-stat-value">{generatedChapters.length}</span>
            <span className="done-stat-label">Chapters</span>
          </div>
          <div className="done-stat">
            <span className="done-stat-value">{analysis?.characters.length ?? 0}</span>
            <span className="done-stat-label">Characters</span>
          </div>
        </div>
      </header>

      <div className="chapter-audio-grid">
        {generatedChapters.map((chapter) => (
          <div className="chapter-audio-card" key={chapter.id}>
            <div className="chapter-audio-title">{chapter.title}</div>
            <audio
              controls
              src={convertFileSrc(chapterAudioPaths[chapter.id])}
              aria-label={`Audio for ${chapter.title}`}
            />
            <button
              className="btn-secondary btn-sm"
              type="button"
              onClick={() => onSaveChapter(chapter)}
            >
              Save…
            </button>
          </div>
        ))}
      </div>

      {savedMessage && <p className="saved-message">{savedMessage}</p>}
    </div>
  );
}
