import type { AnalysisState, PipelineStage, VoiceOption } from "../../types";
import type { CorrectionState } from "../../state/corrections";
import { Step3Review } from "../steps/Step3Review";

interface ReviewContainerProps {
  analysis: AnalysisState;
  correctionState: CorrectionState;
  savedMessage: string | null;
  stage: PipelineStage;
  isBusy: boolean;
  voices: VoiceOption[];
  onSave: () => void;
  onContinue: () => void;
  onGenderChange: (characterId: string, gender: string) => void;
  onVoiceChange: (characterId: string, voiceId: string) => void;
  onPreviewVoice: (voiceId: string) => void;
}

export function ReviewContainer({
  analysis,
  correctionState,
  savedMessage,
  stage,
  isBusy,
  voices,
  onSave,
  onContinue,
  onGenderChange,
  onVoiceChange,
  onPreviewVoice,
}: ReviewContainerProps) {
  return (
    <Step3Review
      analysis={analysis}
      correctionState={correctionState}
      savedMessage={savedMessage}
      isBusy={isBusy}
      isSaving={stage === "saving"}
      voices={voices}
      onSave={onSave}
      onContinue={onContinue}
      onGenderChange={onGenderChange}
      onVoiceChange={onVoiceChange}
      onPreviewVoice={onPreviewVoice}
    />
  );
}
