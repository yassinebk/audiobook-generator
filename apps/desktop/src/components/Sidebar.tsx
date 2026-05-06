import type { AnalysisState, BookState, WorkspaceStep } from "../types";

interface SidebarProps {
  currentStep: WorkspaceStep;
  book: BookState | null;
  analysis: AnalysisState | null;
  chapterAudioPaths: Record<string, string>;
  correctionDirty: boolean;
  isBusy: boolean;
  error: string | null;
  onNavigate: (step: WorkspaceStep) => void;
  onStop: () => void;
  onDismissError: () => void;
}

interface StepDef {
  num: 1 | 2 | 3 | 4;
  label: string;
  sub: string;
}

export function Sidebar({
  currentStep,
  book,
  analysis,
  chapterAudioPaths,
  correctionDirty,
  isBusy,
  error,
  onNavigate,
  onStop,
  onDismissError,
}: SidebarProps) {
  const audioCount = Object.keys(chapterAudioPaths).length;

  const stepDefs: StepDef[] = [
    {
      num: 1,
      label: "Import",
      sub: book
        ? book.title.slice(0, 24) + (book.title.length > 24 ? "…" : "")
        : "Select file",
    },
    {
      num: 2,
      label: "Analyze",
      sub: analysis ? `${analysis.characters.length} chars` : "Chapters & voices",
    },
    {
      num: 3,
      label: "Review",
      sub: correctionDirty ? "Unsaved changes" : "Character edits",
    },
    {
      num: 4,
      label: "Generate",
      sub: audioCount > 0 ? `${audioCount} rendered` : "TTS synthesis",
    },
  ];

  function getStepState(num: 1 | 2 | 3 | 4): "active" | "done" | "waiting" {
    const current = currentStep === "done" ? 5 : (currentStep as number);
    if (num < current) return "done";
    if (num === current) return "active";
    return "waiting";
  }

  function canNavigateTo(step: WorkspaceStep): boolean {
    if (isBusy) return false;
    if (step === 1) return true;
    if (step === 2) return book !== null;
    if (step === 3) return analysis !== null;
    if (step === 4) return analysis !== null;
    if (step === "done") return audioCount > 0;
    return false;
  }

  return (
    <aside className="sidebar" aria-label="Workspace">
      <div className="sidebar-brand">
        <span className="brand-icon">🎙</span>
        <span className="brand-name">
          Audiobook
          <br />
          Generator
        </span>
      </div>

      <nav className="stepper" aria-label="Pipeline steps">
        {stepDefs.map(({ num, label, sub }) => {
          const state = getStepState(num);
          const clickable = state === "done" && canNavigateTo(num);
          return (
            <button
              key={num}
              className={`step-row step-${state}`}
              onClick={() => clickable && onNavigate(num)}
              disabled={!clickable}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="step-circle">{state === "done" ? "✓" : num}</span>
              <span className="step-meta">
                <span className="step-label">{label}</span>
                <span className="step-sub">{sub}</span>
              </span>
            </button>
          );
        })}

        <button
          className={`step-row ${
            currentStep === "done"
              ? "step-active"
              : audioCount > 0
              ? "step-done"
              : "step-waiting"
          }`}
          onClick={() => canNavigateTo("done") && onNavigate("done")}
          disabled={!canNavigateTo("done")}
        >
          <span className="step-circle">{audioCount > 0 ? "✓" : "5"}</span>
          <span className="step-meta">
            <span className="step-label">Listen</span>
            <span className="step-sub">
              {audioCount > 0 ? `${audioCount} chapters` : "Play audio"}
            </span>
          </span>
        </button>
      </nav>

      {isBusy && (
        <button className="btn-stop" type="button" onClick={onStop}>
          ■ Stop
        </button>
      )}

      {error && (
        <div className="sidebar-error">
          <strong>Error</strong>
          <p>{error}</p>
          <button className="btn-secondary" type="button" onClick={onDismissError}>
            Dismiss
          </button>
        </div>
      )}
    </aside>
  );
}
