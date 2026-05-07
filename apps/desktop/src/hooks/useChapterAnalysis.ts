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
import type { DetailTab } from "../state/pipelineStore";

interface UseChapterAnalysisDeps {
  book: BookState | null;
  analysis: AnalysisState | null;
  selectedChapters: Set<string>;
  setStage: (stage: PipelineStage) => void;
  setError: (error: string | null) => void;
  setSavedMessage: (msg: string | null) => void;
  setAnalyzeProgress: (msg: string) => void;
  setChapterStatuses: (statuses: Record<string, string>) => void;
  setProgressDetail: (
    details: ProgressDetail[] | ((prev: ProgressDetail[]) => ProgressDetail[]),
  ) => void;
  setProgress: (progress: number) => void;
  setAnalysis: (
    analysis:
      | AnalysisState
      | null
      | ((prev: AnalysisState | null) => AnalysisState | null),
  ) => void;
  setCurrentStep: (step: WorkspaceStep) => void;
  setTab: (tab: DetailTab) => void;
  abortRef: React.MutableRefObject<AbortController | null>;
  db: {
    upsertChapter: (record: {
      id: string;
      bookId: string;
      title: string;
      status: string;
      scriptPath?: string;
    }) => Promise<unknown>;
    upsertCharacter: (record: {
      id: string; bookId: string; canonicalName: string;
      gender?: string | null; voiceId?: string | null;
      confidence?: number; aliases?: string;
    }) => Promise<unknown>;
  };
}

export function useChapterAnalysis(deps: UseChapterAnalysisDeps) {
  const {
    book,
    analysis,
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
    setTab,
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
    setProgress(0);
    setAnalyzeProgress("Starting analysis...");
    setChapterStatuses({});
    setProgressDetail([{ label: "Model", value: "DeepSeek Flash" }]);

    const startTime = Date.now();
    const modelLabel = "DeepSeek Flash";

    const chaptersToAnalyze = book.chapters.filter((c) =>
      selectedChapters.has(c.id),
    );

    // Characters accumulated across this run (seeded with previously-found ones).
    // Each chapter receives the full list so the LLM can maintain consistency.
    type KnownChar = { id: string; canonicalName: string; aliases: string[]; gender: string };
    const knownCharacters: KnownChar[] = (analysis?.characters ?? []).map((c) => ({
      id: c.id,
      canonicalName: c.canonicalName,
      aliases: c.aliases ?? [],
      gender: c.gender,
    }));

    // Track elapsed time alongside chapter progress
    const elapsedTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      setProgressDetail((prev: ProgressDetail[]) => {
        const next = prev.filter((d: ProgressDetail) => d.label !== "Elapsed");
        return [...next, { label: "Elapsed", value: `${elapsed}s` }];
      });
    }, 1000);

    try {
      const statuses: Record<string, string> = {};
      let doneCount = 0;

      for (let i = 0; i < chaptersToAnalyze.length; i++) {
        if (controller.signal.aborted) break;
        const chapter = chaptersToAnalyze[i];

        // Progress: 0 → 100% linearly as chapters complete
        setProgress(Math.round((i / chaptersToAnalyze.length) * 100));
        setAnalyzeProgress(
          `Analyzing chapter ${i + 1} of ${chaptersToAnalyze.length}…`,
        );
        setProgressDetail([
          { label: "Model", value: modelLabel },
          { label: "Progress", value: `${i + 1} / ${chaptersToAnalyze.length}` },
          {
            label: "Current",
            value: chapter.title.length > 30
              ? chapter.title.slice(0, 30) + "…"
              : chapter.title,
          },
          { label: "Elapsed", value: `${Math.round((Date.now() - startTime) / 1000)}s` },
        ]);
        statuses[chapter.id] = "analyzing";
        setChapterStatuses({ ...statuses });

        try {
          const result = await workerCall("analyze_chapter", {
            bookId: book.bookId,
            chapterId: chapter.id,
            title: chapter.title,
            chapterTextPath: chapter.textPath,
            outputDirectory: `${book.workDir}/scripts`,
            // Pass accumulated character context for cross-chapter consistency
            knownCharacters: knownCharacters.length > 0 ? knownCharacters : undefined,
          });

          if (result.status !== "succeeded") {
            statuses[chapter.id] = "failed";
            setChapterStatuses({ ...statuses });
            continue;
          }

          const artifact = (result.artifacts as Array<{ path: string }>)[0];
          statuses[chapter.id] = "done";
          doneCount++;

          db.upsertChapter({
            id: chapter.id,
            bookId: book.bookId,
            title: chapter.title,
            status: "succeeded",
            scriptPath: artifact.path,
          }).catch(() => {});

          // Read script to extract characters
          const scriptRaw = await invoke<string>("run_worker", {
            command: "_read_file",
            inputJson: JSON.stringify({ path: artifact.path }),
          }).catch(() => "{}");

          const scriptData = JSON.parse(scriptRaw) as {
            characters?: CharacterMeta[];
            voices?: AnalysisState["voices"];
          } | null;

          const newChars = scriptData?.characters ?? [];
          const newVoices = scriptData?.voices ?? [];

          // Add newly discovered characters to the running context for next chapters
          const knownIds = new Set(knownCharacters.map((c) => c.id));
          for (const c of newChars) {
            if (!knownIds.has(c.id)) {
              knownCharacters.push({
                id: c.id,
                canonicalName: c.canonicalName,
                aliases: c.aliases ?? [],
                gender: c.gender,
              });
              knownIds.add(c.id);
            }
          }

          // Persist characters to DB
          for (const c of newChars) {
            db.upsertCharacter({
              id: c.id,
              bookId: book.bookId,
              canonicalName: c.canonicalName,
              gender: c.gender,
              voiceId: c.voiceId,
              confidence: c.confidence,
              aliases: JSON.stringify(c.aliases),
            }).catch(() => {});
          }

          // Merge into existing analysis state in real-time
          setAnalysis((prev) => {
            const existingCharIds = new Set(
              (prev?.characters ?? []).map((c) => c.id),
            );
            const existingVoiceIds = new Set(
              (prev?.voices ?? []).map((v) => v.id),
            );
            return {
              characters: [
                ...(prev?.characters ?? []),
                ...newChars.filter((c) => !existingCharIds.has(c.id)),
              ],
              voices: [
                ...(prev?.voices ?? []),
                ...newVoices.filter((v) => !existingVoiceIds.has(v.id)),
              ],
              scriptPaths: {
                ...(prev?.scriptPaths ?? {}),
                [chapter.id]: artifact.path,
              },
            };
          });
        } catch {
          statuses[chapter.id] = "failed";
        }

        setChapterStatuses({ ...statuses });
      }

      clearInterval(elapsedTimer);
      const wasStopped = controller.signal.aborted;
      const failedCount = Object.values(statuses).filter((s) => s === "failed").length;

      setProgress(100);
      setProgressDetail([]);
      setAnalyzeProgress(
        wasStopped
          ? `Stopped after ${doneCount} of ${chaptersToAnalyze.length} chapters.`
          : failedCount > 0
            ? `Done: ${doneCount} analyzed, ${failedCount} failed.`
            : `${doneCount} chapter${doneCount !== 1 ? "s" : ""} analyzed.`,
      );
      setStage("idle");
      abortRef.current = null;

      if (doneCount > 0) {
        setCurrentStep(3);
        // Auto-advance to review tab so user can see characters
        setTab("review");
      }
    } catch (err) {
      clearInterval(elapsedTimer);
      if (!controller.signal.aborted) {
        setError(String(err));
        setStage("error");
      } else {
        setProgress(100);
        setProgressDetail([]);
        setAnalyzeProgress("Analysis stopped.");
        setStage("idle");
        abortRef.current = null;
      }
    }
  }, [
    book,
    analysis,
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
    setTab,
  ]);

  return { handleAnalyze };
}
