import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import type {
  AnalysisState,
  BookState,
  CharacterMeta,
  PipelineStage,
  ProgressDetail,
  WorkspaceStep,
} from "../types";
import { workerCall } from "../lib/workerCall";

interface UseChapterAnalysisDeps {
  book: BookState | null;
  selectedChapters: Set<string>;
  setStage: (stage: PipelineStage) => void;
  setError: (error: string | null) => void;
  setSavedMessage: (msg: string | null) => void;
  setAnalyzeProgress: (msg: string) => void;
  setChapterStatuses: (statuses: Record<string, string>) => void;
  setProgressDetail: (details: ProgressDetail[]) => void;
  setProgress: (progress: number) => void;
  setAnalysis: (analysis: AnalysisState | null) => void;
  setCurrentStep: (step: WorkspaceStep) => void;
  abortRef: React.MutableRefObject<AbortController | null>;
  db: {
    upsertChapter: (record: {
      id: string;
      bookId: string;
      title: string;
      status: string;
      scriptPath?: string;
    }) => Promise<unknown>;
  };
}

export function useChapterAnalysis(deps: UseChapterAnalysisDeps) {
  const {
    book,
    selectedChapters,
    setStage,
    setError,
    setSavedMessage,
    setAnalyzeProgress,
    setChapterStatuses,
    setProgressDetail,
    setProgress,
    setAnalysis,
    setCurrentStep,
    abortRef,
    db,
  } = deps;

  const handleAnalyze = useCallback(async () => {
    if (!book) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage("analyzing");
    setError(null);
    setSavedMessage(null);
    setAnalyzeProgress("Starting analysis...");
    setChapterStatuses({});
    setProgressDetail([
      { label: "Model", value: "DeepSeek Flash" },
      { label: "Chapters", value: String(book.chapters.length) },
    ]);

    const startTime = Date.now();
    const modelLabel = "DeepSeek Flash";

    try {
      const scriptDir = `${book.workDir}/scripts`;
      const scripts: Record<string, string> = {};
      const allCharacters: CharacterMeta[] = [];
      const allVoices: AnalysisState["voices"] = [];
      const seenCharIds = new Set<string>();
      const seenVoiceIds = new Set<string>();
      const statuses: Record<string, string> = {};

      const chaptersToAnalyze = book.chapters.filter((c) =>
        selectedChapters.has(c.id),
      );

      for (let i = 0; i < chaptersToAnalyze.length; i++) {
        if (controller.signal.aborted) break;
        const chapter = chaptersToAnalyze[i];

        setProgress(10 + Math.round((i / chaptersToAnalyze.length) * 25));
        setAnalyzeProgress(
          `Analyzing chapter ${i + 1} of ${chaptersToAnalyze.length} using ${modelLabel}...`,
        );
        setProgressDetail([
          { label: "Model", value: modelLabel },
          {
            label: "Progress",
            value: `Chapter ${i + 1} of ${chaptersToAnalyze.length}`,
          },
          {
            label: "Current",
            value:
              chapter.title.length > 30
                ? chapter.title.slice(0, 30) + "..."
                : chapter.title,
          },
          {
            label: "Elapsed",
            value: `${Math.round((Date.now() - startTime) / 1000)}s`,
          },
        ]);
        statuses[chapter.id] = "analyzing";
        setChapterStatuses({ ...statuses });

        try {
          const result = await workerCall("analyze_chapter", {
            bookId: book.bookId,
            chapterId: chapter.id,
            title: chapter.title,
            chapterTextPath: chapter.textPath,
            outputDirectory: scriptDir,
          });

          if (result.status !== "succeeded") {
            statuses[chapter.id] = "failed";
            setChapterStatuses({ ...statuses });
            continue;
          }

          const artifact = (result.artifacts as Array<{ path: string }>)[0];
          scripts[chapter.id] = artifact.path;
          statuses[chapter.id] = "done";
          db.upsertChapter({
            id: chapter.id,
            bookId: book.bookId,
            title: chapter.title,
            status: "succeeded",
            scriptPath: artifact.path,
          }).catch(() => {});

          const scriptRaw = await invoke<string>("run_worker", {
            command: "_read_file",
            inputJson: JSON.stringify({ path: artifact.path }),
          }).catch(() => "{}");

          const scriptData = JSON.parse(scriptRaw) as {
            characters?: CharacterMeta[];
            voices?: AnalysisState["voices"];
          } | null;

          for (const v of scriptData?.voices ?? []) {
            if (!seenVoiceIds.has(v.id)) {
              seenVoiceIds.add(v.id);
              allVoices.push(v);
            }
          }
          for (const c of scriptData?.characters ?? []) {
            if (!seenCharIds.has(c.id)) {
              seenCharIds.add(c.id);
              allCharacters.push(c);
            }
          }
        } catch {
          statuses[chapter.id] = "failed";
        }

        setChapterStatuses({ ...statuses });
      }

      const doneCount = Object.values(statuses).filter(
        (s) => s === "done",
      ).length;
      const wasStopped = controller.signal.aborted;

      if (doneCount > 0) {
        setAnalysis({
          characters: allCharacters,
          voices: allVoices,
          scriptPaths: scripts,
        });
      }
      setAnalyzeProgress(
        wasStopped
          ? `Stopped after ${doneCount} of ${chaptersToAnalyze.length} chapters.${doneCount > 0 ? " You can generate audio for completed chapters." : ""}`
          : `Analysis complete: ${doneCount} of ${book.chapters.length} chapters analyzed.`,
      );
      setProgress(40);
      setStage("idle");
      abortRef.current = null;
      if (doneCount > 0) setCurrentStep(3);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(String(err));
        setStage("error");
      } else {
        setAnalyzeProgress("Analysis stopped.");
        setStage("idle");
        abortRef.current = null;
      }
    }
  }, [
    book,
    selectedChapters,
    abortRef,
    db,
    setAnalysis,
    setAnalyzeProgress,
    setChapterStatuses,
    setCurrentStep,
    setError,
    setProgress,
    setProgressDetail,
    setSavedMessage,
    setStage,
  ]);

  return { handleAnalyze };
}
