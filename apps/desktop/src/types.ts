export interface ChapterMeta {
  id: string;
  title: string;
  textLength: number;
  textPath: string;
}

export interface CharacterMeta {
  id: string;
  canonicalName: string;
  aliases: string[];
  gender: string;
  voiceId: string;
  confidence: number;
}

export interface VoiceMeta {
  id: string;
  displayName: string;
  backend: string;
}

export interface VoiceOption {
  id: string;
  displayName: string;
}

export interface BookState {
  title: string;
  bookId: string;
  workDir: string;
  chapters: ChapterMeta[];
}

export interface AnalysisState {
  characters: CharacterMeta[];
  voices: VoiceMeta[];
  scriptPaths: Record<string, string>;
}

export interface RightsResult {
  classification: string;
  reason: string;
  requiresAttestation: boolean;
  evidence: string[];
}

export interface ProgressDetail {
  label: string;
  value: string;
}

export type PipelineStage =
  | "idle"
  | "importing"
  | "analyzing"
  | "saving"
  | "generating"
  | "done"
  | "error";

export type WorkspaceStep = 1 | 2 | 3 | 4 | "done";
