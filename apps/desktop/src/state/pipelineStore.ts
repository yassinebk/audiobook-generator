import { create } from "zustand";
import type {
  AnalysisState,
  PipelineStage,
  ProgressDetail,
} from "../types";

export type DetailTab = "analyze" | "review" | "generate";

interface PipelineState {
  analysis: AnalysisState | null;
  chapterAudioPaths: Record<string, string>;
  stage: PipelineStage;
  error: string | null;
  progress: number;
  savedMessage: string | null;
  analyzeProgress: string;
  chapterStatuses: Record<string, string>;
  progressDetail: ProgressDetail[];
  selectedChapters: Set<string>;
  tab: DetailTab;

  setAnalysis: (
    analysis:
      | AnalysisState
      | null
      | ((
          prev: AnalysisState | null,
        ) => AnalysisState | null),
  ) => void;
  setChapterAudioPaths: (
    paths:
      | Record<string, string>
      | ((
          prev: Record<string, string>,
        ) => Record<string, string>),
  ) => void;
  setStage: (stage: PipelineStage) => void;
  setError: (error: string | null) => void;
  setProgress: (progress: number) => void;
  setSavedMessage: (msg: string | null) => void;
  setAnalyzeProgress: (msg: string) => void;
  setChapterStatuses: (
    statuses: Record<string, string>,
  ) => void;
  setProgressDetail: (details: ProgressDetail[]) => void;
  setSelectedChapters: (
    chapters:
      | Set<string>
      | ((prev: Set<string>) => Set<string>),
  ) => void;
  setTab: (tab: DetailTab) => void;
  resetPipeline: () => void;
}

export const usePipelineStore = create<PipelineState>((set) => ({
  analysis: null,
  chapterAudioPaths: {},
  stage: "idle",
  error: null,
  progress: 0,
  savedMessage: null,
  analyzeProgress: "",
  chapterStatuses: {},
  progressDetail: [],
  selectedChapters: new Set(),
  tab: "analyze",

  setAnalysis: (analysis) =>
    set((s) => ({
      analysis:
        typeof analysis === "function" ? analysis(s.analysis) : analysis,
    })),

  setChapterAudioPaths: (paths) =>
    set((s) => ({
      chapterAudioPaths:
        typeof paths === "function"
          ? paths(s.chapterAudioPaths)
          : paths,
    })),

  setStage: (stage) => set({ stage }),
  setError: (error) => set({ error }),
  setProgress: (progress) => set({ progress }),
  setSavedMessage: (savedMessage) => set({ savedMessage }),
  setAnalyzeProgress: (analyzeProgress) => set({ analyzeProgress }),
  setChapterStatuses: (chapterStatuses) => set({ chapterStatuses }),
  setProgressDetail: (progressDetail) => set({ progressDetail }),
  setSelectedChapters: (chapters) =>
    set((s) => ({
      selectedChapters:
        typeof chapters === "function"
          ? chapters(s.selectedChapters)
          : chapters,
    })),
  setTab: (tab) => set({ tab }),
  resetPipeline: () =>
    set({
      analysis: null,
      chapterAudioPaths: {},
      stage: "idle",
      error: null,
      progress: 0,
      savedMessage: null,
      analyzeProgress: "",
      chapterStatuses: {},
      progressDetail: [],
      selectedChapters: new Set(),
      tab: "analyze",
    }),
}));
