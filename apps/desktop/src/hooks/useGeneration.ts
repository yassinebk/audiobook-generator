import { useCallback } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import type {
  AnalysisState,
  BookState,
  ChapterMeta,
  PipelineStage,
  ProgressDetail,
  WorkspaceStep,
} from "../types";
import { generationProgressDetails } from "../lib/generationProgress";
import { synthesizeChapter } from "../lib/generation";

interface UseGenerationDeps {
  book: BookState | null;
  analysis: AnalysisState | null;
  selectedChapters: Set<string>;
  chapterAudioPaths: Record<string, string>;
  correctionState: { affectedChapters: string[]; dirty?: boolean };
  setStage: (stage: PipelineStage) => void;
  setError: (error: string | null) => void;
  setAnalyzeProgress: (msg: string) => void;
  setProgressDetail: (details: ProgressDetail[]) => void;
  setProgress: (progress: number) => void;
  setChapterAudioPaths: (
    paths:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  setCurrentStep: (step: WorkspaceStep) => void;
  abortRef: React.MutableRefObject<AbortController | null>;
}

export function useGeneration(deps: UseGenerationDeps) {
  const {
    book,
    analysis,
    selectedChapters,
    chapterAudioPaths,
    correctionState,
    setStage,
    setError,
    setAnalyzeProgress,
    setProgressDetail,
    setProgress,
    setChapterAudioPaths,
    setCurrentStep,
    abortRef,
  } = deps;

  const generateChapters = useCallback(
    async (chaptersToGenerate: ChapterMeta[]) => {
      if (!book || !analysis) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStage("generating");
      setError(null);
      setAnalyzeProgress("");

      setProgressDetail([
        { label: "Backend", value: "Parler TTS (MPS)" },
        { label: "Chapters", value: String(chaptersToGenerate.length) },
      ]);

      const startTime = Date.now();
      let totalSegments = 0;
      let doneSegments = 0;

      try {
        const newAudioPaths: Record<string, string> = {};

        for (let ci = 0; ci < chaptersToGenerate.length; ci++) {
          if (controller.signal.aborted) break;
          const chapter = chaptersToGenerate[ci];
          const scriptPath = analysis.scriptPaths[chapter.id];
          if (!scriptPath) continue;

          const segDir = `${book.workDir}/segments/${chapter.id}`;
          const assembledPath = `${book.workDir}/audio/${chapter.id}.wav`;

          const scriptRaw = await invoke<string>("run_worker", {
            command: "_read_file",
            inputJson: JSON.stringify({ path: scriptPath }),
          }).catch(() => "{}");

          const script = JSON.parse(scriptRaw) as {
            segments?: Array<{
              id: string;
              voiceId?: string;
              emotion?: string;
            }>;
          };
          const segments = script.segments ?? [];

          setAnalyzeProgress(
            `Synthesizing chapter ${ci + 1} of ${chaptersToGenerate.length} (${segments.length} segments)...`,
          );
          totalSegments += segments.length;

          const setGenerationProgress = () => {
            setProgress(
              40 +
                Math.round((doneSegments / Math.max(totalSegments, 1)) * 50),
            );
            setProgressDetail(
              generationProgressDetails({
                now: Date.now(),
                startTime,
                doneSegments,
                totalSegments,
                chapterIndex: ci + 1,
                chapterCount: chaptersToGenerate.length,
                segmentCount: segments.length,
              }),
            );
          };

          flushSync(() => {
            setGenerationProgress();
          });

          const progressTimer = window.setInterval(setGenerationProgress, 1000);
          let result: Record<string, unknown>;
          try {
            result = await synthesizeChapter({
              scriptPath,
              segmentAudioDirectory: segDir,
              outputPath: assembledPath,
            });
          } finally {
            window.clearInterval(progressTimer);
          }
          doneSegments += segments.length;

          if (result.status === "succeeded") {
            newAudioPaths[chapter.id] = assembledPath;
          }
        }

        setChapterAudioPaths((prev) => ({ ...prev, ...newAudioPaths }));
        const wasStopped = controller.signal.aborted;
        setProgress(
          wasStopped
            ? 40 +
                Math.round((doneSegments / Math.max(totalSegments, 1)) * 50)
            : 100,
        );
        setAnalyzeProgress(
          wasStopped
            ? "Generation stopped. Partial audio available."
            : "Audio generation complete.",
        );
        const generatedCount = Object.keys(newAudioPaths).length;
        setStage(generatedCount > 0 || !wasStopped ? "done" : "idle");
        abortRef.current = null;
        if (generatedCount > 0) setCurrentStep("done");
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(String(err));
          setStage("error");
        } else {
          setAnalyzeProgress("Generation stopped.");
          setStage("idle");
          abortRef.current = null;
        }
      }
    },
    [
      book,
      analysis,
      abortRef,
      setAnalyzeProgress,
      setChapterAudioPaths,
      setCurrentStep,
      setError,
      setProgress,
      setProgressDetail,
      setStage,
    ],
  );

  const handleGenerate = useCallback(async () => {
    if (!book || !analysis) return;
    const chaptersToGenerate = (
      correctionState.affectedChapters.length > 0
        ? book.chapters.filter((c) =>
            correctionState.affectedChapters.includes(c.id),
          )
        : book.chapters
    ).filter(
      (c) => selectedChapters.has(c.id) && analysis.scriptPaths[c.id],
    );

    await generateChapters(chaptersToGenerate);
  }, [book, analysis, correctionState.affectedChapters, selectedChapters, generateChapters]);

  const handleRegenerateChapter = useCallback(
    async (chapter: ChapterMeta) => {
      await generateChapters([chapter]);
    },
    [generateChapters],
  );

  const handleRegenerateAll = useCallback(async () => {
    if (!book) return;
    const generatedChapters = book.chapters.filter(
      (c) => chapterAudioPaths[c.id],
    );
    await generateChapters(generatedChapters);
  }, [book, chapterAudioPaths, generateChapters]);

  return { handleGenerate, handleRegenerateChapter, handleRegenerateAll };
}
