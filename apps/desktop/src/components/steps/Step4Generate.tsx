import type { AnalysisState, BookState, ProgressDetail } from "../../types";

interface Step4GenerateProps {
  book: BookState;
  analysis: AnalysisState;
  selectedChapters: Set<string>;
  correctionDirty: boolean;
  chapterAudioPaths: Record<string, string>;
  isBusy: boolean;
  isGenerating: boolean;
  analyzeProgress: string;
  progressDetail: ProgressDetail[];
  progress: number;
  onGenerate: () => void;
  onContinue: () => void;
}

export function Step4Generate({
  book,
  analysis,
  selectedChapters,
  correctionDirty,
  chapterAudioPaths,
  isBusy,
  isGenerating,
  analyzeProgress,
  progressDetail,
  progress,
  onGenerate,
  onContinue,
}: Step4GenerateProps) {
  const chaptersReady = book.chapters.filter(
    (c) => selectedChapters.has(c.id) && analysis.scriptPaths[c.id],
  );
  const audioCount = Object.keys(chapterAudioPaths).length;

  return (
    <div className="step-workspace visible" aria-label="Step 4: Generate">
      <header className="step-header">
        <p className="eyebrow">Step 4 of 4</p>
        <h2>Generate Audio</h2>
        <p className="step-desc">
          Synthesize selected chapters with Parler TTS on-device.
        </p>
      </header>

      <div className="generate-layout">
        <div className="generate-info">
          <div className="result-row">
            <span className="result-label">Ready</span>
            <span className="result-value">{chaptersReady.length} chapters</span>
          </div>
          <div className="result-row">
            <span className="result-label">Backend</span>
            <span className="result-value">Parler TTS (MPS)</span>
          </div>
          {correctionDirty && (
            <div className="result-row">
              <span className="result-label warn">⚠</span>
              <span className="result-value warn">Unsaved corrections — go back to Review</span>
            </div>
          )}
        </div>

        <div className="generate-action">
          {analyzeProgress && (
            <p className="analyze-progress">{analyzeProgress}</p>
          )}
          {progressDetail.length > 0 && isGenerating && (
            <div className="progress-detail">
              {progressDetail.map((d) => (
                <span key={d.label} className="progress-detail-item">
                  <strong>{d.label}</strong> {d.value}
                </span>
              ))}
            </div>
          )}
          <progress value={progress} max="100" aria-label="Generation progress" />
          <button
            className="btn-primary"
            type="button"
            onClick={onGenerate}
            disabled={isBusy || chaptersReady.length === 0}
          >
            {isGenerating ? (
              <>
                <span className="spinner" /> Generating…
              </>
            ) : (
              `Generate ${chaptersReady.length} chapter${chaptersReady.length !== 1 ? "s" : ""}`
            )}
          </button>
          {audioCount > 0 && (
            <button className="btn-secondary" type="button" onClick={onContinue}>
              Listen to results →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
