import type { CorrectionState } from "../../state/corrections";
import type { AnalysisState, VoiceOption } from "../../types";
import { CharacterTable } from "../CharacterTable";

interface Step3ReviewProps {
  analysis: AnalysisState;
  correctionState: CorrectionState;
  savedMessage: string | null;
  isBusy: boolean;
  isSaving: boolean;
  voices: VoiceOption[];
  onSave: () => void;
  onContinue: () => void;
  onGenderChange: (characterId: string, gender: string) => void;
  onVoiceChange: (characterId: string, voiceId: string) => void;
  onPreviewVoice: (voiceId: string) => void;
}

export function Step3Review({
  analysis,
  correctionState,
  savedMessage,
  isBusy,
  isSaving,
  voices,
  onSave,
  onContinue,
  onGenderChange,
  onVoiceChange,
  onPreviewVoice,
}: Step3ReviewProps) {
  return (
    <div className="step-workspace visible" aria-label="Step 3: Review">
      <header className="step-header">
        <p className="eyebrow">Step 3 of 4</p>
        <h2>Review Characters</h2>
        <p className="step-desc">
          Correct gender, merge aliases, and assign voices before generating audio.
        </p>
      </header>

      <div className="review-layout">
        <div className="review-table-panel">
          {savedMessage && <p className="saved-message">{savedMessage}</p>}
          <CharacterTable
            characters={analysis.characters}
            voices={voices}
            onGenderChange={onGenderChange}
            onVoiceChange={onVoiceChange}
            onPreviewVoice={onPreviewVoice}
          />
          {correctionState.dirty && (
            <p className="hint">Unsaved corrections — save before generating.</p>
          )}
        </div>

        <div className="review-action-panel">
          <button
            className="btn-primary"
            type="button"
            onClick={onSave}
            disabled={!correctionState.dirty || isBusy}
          >
            {isSaving ? (
              <>
                <span className="spinner" /> Saving…
              </>
            ) : (
              "Save Corrections"
            )}
          </button>
          <button className="btn-secondary" type="button" onClick={onContinue}>
            Continue to Generate →
          </button>
        </div>
      </div>
    </div>
  );
}
