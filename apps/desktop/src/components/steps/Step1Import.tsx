import type { BookState, RightsResult } from "../../types";

interface Step1ImportProps {
  book: BookState | null;
  rights: RightsResult | null;
  rightsAttested: boolean;
  isBusy: boolean;
  isImporting: boolean;
  onImport: () => void;
  onAttest: (checked: boolean) => void;
  onContinue: () => void;
}

export function Step1Import({
  book,
  rights,
  rightsAttested,
  isBusy,
  isImporting,
  onImport,
  onAttest,
  onContinue,
}: Step1ImportProps) {
  const blocked = rights?.classification === "blocked";
  const needsAttestation = rights?.requiresAttestation && !rightsAttested;

  return (
    <div className="step-workspace visible" aria-label="Step 1: Import">
      <header className="step-header">
        <p className="eyebrow">Step 1 of 4</p>
        <h2>Import Book</h2>
        <p className="step-desc">
          Select an EPUB or PDF to extract chapters and check rights.
        </p>
      </header>

      <div className="import-area">
        <button
          className="btn-primary btn-import"
          type="button"
          onClick={onImport}
          disabled={isBusy}
        >
          {isImporting ? (
            <>
              <span className="spinner" /> Importing…
            </>
          ) : (
            <>
              <span className="import-icon">📂</span> Choose File
            </>
          )}
        </button>
        {isImporting && <p className="import-hint">Extracting chapters…</p>}
      </div>

      {book && (
        <div className="import-result">
          <div className="result-row">
            <span className="result-label">Title</span>
            <span className="result-value">{book.title}</span>
          </div>
          <div className="result-row">
            <span className="result-label">Chapters</span>
            <span className="result-value">{book.chapters.length}</span>
          </div>

          {rights && (
            <div className="result-row">
              <span className="result-label">Rights</span>
              <span className={`rights-strip rights-${rights.classification}`}>
                {rights.classification.toUpperCase()}
              </span>
            </div>
          )}

          {rights?.requiresAttestation && (
            <label className="attestation">
              <input
                type="checkbox"
                checked={rightsAttested}
                onChange={(e) => onAttest(e.target.checked)}
              />
              <span>I have the right to convert this book</span>
            </label>
          )}

          <button
            className="btn-primary"
            type="button"
            onClick={onContinue}
            disabled={blocked || needsAttestation}
          >
            Continue to Analyze →
          </button>
        </div>
      )}
    </div>
  );
}
