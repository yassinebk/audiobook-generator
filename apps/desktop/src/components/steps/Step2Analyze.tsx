import type { AnalysisState, BookState, ProgressDetail, RightsResult } from "../../types";

interface Step2AnalyzeProps {
  book: BookState;
  analysis: AnalysisState | null;
  rights: RightsResult | null;
  rightsAttested: boolean;
  isBusy: boolean;
  isAnalyzing: boolean;
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

export function Step2Analyze({
  book,
  analysis,
  rights,
  rightsAttested,
  isBusy,
  isAnalyzing,
  selectedChapters,
  chapterStatuses,
  analyzeProgress,
  progressDetail,
  progress,
  onAnalyze,
  onToggleChapter,
  onToggleAll,
  onContinue,
}: Step2AnalyzeProps) {
  const allSelected =
    book.chapters.length > 0 && book.chapters.every((c) => selectedChapters.has(c.id));
  const blocked = rights?.classification === "blocked";
  const needsAttestation = rights?.requiresAttestation && !rightsAttested;
  const canAnalyze = !isBusy && selectedChapters.size > 0 && !blocked && !needsAttestation;

  return (
    <div className="step-workspace visible" aria-label="Step 2: Analyze">
      <header className="step-header">
        <p className="eyebrow">Step 2 of 4</p>
        <h2>Analyze Chapters</h2>
        <p className="step-desc">
          Select chapters to analyze for dialogue, characters, and voice casting.
        </p>
      </header>

      <div className="analyze-layout">
        <div className="chapter-select-panel">
          <div className="panel-toolbar">
            <label className="select-all-label">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                disabled={isBusy}
              />
              {allSelected ? "Deselect all" : "Select all"} · {selectedChapters.size}/
              {book.chapters.length}
            </label>
          </div>

          <ul className="chapter-list">
            {book.chapters.map((c) => (
              <li
                key={c.id}
                className={`chapter-item ${
                  chapterStatuses[c.id] === "failed" ? "chapter-failed" : ""
                }`}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={selectedChapters.has(c.id)}
                    onChange={() => onToggleChapter(c.id)}
                    disabled={isBusy}
                  />
                  <span className="chapter-title">
                    {c.title}
                    {chapterStatuses[c.id] === "done" && (
                      <span className="status-chip chip-done">✓</span>
                    )}
                    {chapterStatuses[c.id] === "analyzing" && (
                      <span className="status-chip chip-running">…</span>
                    )}
                    {chapterStatuses[c.id] === "failed" && (
                      <span className="status-chip chip-fail">✗</span>
                    )}
                  </span>
                  <small className="chapter-size">
                    {Math.round(c.textLength / 1000)}k chars
                  </small>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="analyze-action-panel">
          {analyzeProgress && (
            <p className="analyze-progress">{analyzeProgress}</p>
          )}
          {progressDetail.length > 0 && isAnalyzing && (
            <div className="progress-detail">
              {progressDetail.map((d) => (
                <span key={d.label} className="progress-detail-item">
                  <strong>{d.label}</strong> {d.value}
                </span>
              ))}
            </div>
          )}
          <progress value={progress} max="100" aria-label="Analysis progress" />
          <button
            className="btn-primary"
            type="button"
            onClick={onAnalyze}
            disabled={!canAnalyze}
          >
            {isAnalyzing ? (
              <>
                <span className="spinner" /> Analyzing…
              </>
            ) : (
              `Analyze ${selectedChapters.size} chapter${selectedChapters.size !== 1 ? "s" : ""}`
            )}
          </button>
          {analysis && (
            <button className="btn-secondary" type="button" onClick={onContinue}>
              Continue to Review →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
