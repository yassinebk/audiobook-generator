import type { BookState, PipelineStage, RightsResult } from "../../types";
import { Step1Import } from "../steps/Step1Import";

interface ImportContainerProps {
  book: BookState | null;
  rights: RightsResult | null;
  rightsAttested: boolean;
  stage: PipelineStage;
  isBusy: boolean;
  onImport: () => void;
  onAttest: (checked: boolean) => void;
  onContinue: () => void;
}

export function ImportContainer({
  book,
  rights,
  rightsAttested,
  stage,
  isBusy,
  onImport,
  onAttest,
  onContinue,
}: ImportContainerProps) {
  return (
    <Step1Import
      book={book}
      rights={rights}
      rightsAttested={rightsAttested}
      isBusy={isBusy}
      isImporting={stage === "importing"}
      onImport={onImport}
      onAttest={onAttest}
      onContinue={onContinue}
    />
  );
}
