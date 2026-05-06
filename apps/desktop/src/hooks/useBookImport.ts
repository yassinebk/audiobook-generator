import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";

import type {
  AnalysisState,
  BookState,
  ChapterMeta,
  CharacterMeta,
  PipelineStage,
  ProgressDetail,
  RightsResult,
  WorkspaceStep,
} from "../types";
import { workerCall } from "../lib/workerCall";
import {
  cachedBookFromExtraction,
  extractionCachePath,
  writeExtractionCache,
} from "../lib/importCache";
interface UseBookImportDeps {
  setBook: (book: BookState | null) => void;
  setAnalysis: (analysis: AnalysisState | null) => void;
  setChapterAudioPaths: (
    paths: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  setStage: (stage: PipelineStage) => void;
  setError: (error: string | null) => void;
  setProgress: (progress: number) => void;
  setRights: (rights: RightsResult | null) => void;
  setRightsAttested: (attested: boolean) => void;
  setAnalyzeProgress: (msg: string) => void;
  setChapterStatuses: (statuses: Record<string, string>) => void;
  setProgressDetail: (details: ProgressDetail[]) => void;
  setSelectedChapters: (chapters: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setCurrentStep: (step: WorkspaceStep) => void;
  setSavedMessage: (msg: string | null) => void;
  abortRef: React.MutableRefObject<AbortController | null>;
  correctionsStore: {
    reset: () => void;
  };
  db: {
    createBook: (record: {
      id: string;
      title: string;
      sourcePath: string;
      workDir: string;
    }) => Promise<unknown>;
    getChaptersWithScripts: (bookId: string) => Promise<Array<{ id: string; scriptPath: string }>>;
  };
}

export function useBookImport(deps: UseBookImportDeps) {
  const {
    setBook,
    setAnalysis,
    setChapterAudioPaths,
    setStage,
    setError,
    setProgress,
    setRights,
    setRightsAttested,
    setAnalyzeProgress,
    setChapterStatuses,
    setProgressDetail,
    setSelectedChapters,
    setCurrentStep,
    setSavedMessage,
    abortRef,
    correctionsStore,
    db,
  } = deps;

  const handleImportBook = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Book", extensions: ["epub", "pdf"] }],
    });
    if (!path) return;

    abortRef.current?.abort();
    setStage("importing");
    setError(null);
    setAnalysis(null);
    setChapterAudioPaths({});
    setRights(null);
    setRightsAttested(false);
    correctionsStore.reset();
    setAnalyzeProgress("");
    setChapterStatuses({});
    setProgressDetail([]);
    setSavedMessage(null);

    try {
      const tmp = await tempDir();
      const bookStem =
        (path as string).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "book";
      const workDir = `${tmp}/audiobook-generator/${bookStem}`;
      const sourcePath = path as string;

      let extracted = await cachedBookFromExtraction({
        cachePath: extractionCachePath(workDir),
        sourcePath,
        readJson: async (cachePath) =>
          await invoke<unknown>("run_worker", {
            command: "_read_file",
            inputJson: JSON.stringify({ path: cachePath }),
          }),
      });

      if (extracted) {
        setAnalyzeProgress("Restored cached book extraction.");
      } else {
        const result = await workerCall("extract_book", {
          bookPath: path,
          outputDirectory: `${workDir}/chapters`,
        });

        if (result.status !== "succeeded") {
          const err = result.error as { message: string } | undefined;
          throw new Error(err?.message ?? "extract_book failed");
        }

        const artifact = (
          result.artifacts as Array<{
            metadata: { title: string; chapters: ChapterMeta[] };
          }>
        )[0];

        extracted = {
          title: artifact.metadata.title,
          bookId: bookStem,
          workDir,
          chapters: artifact.metadata.chapters,
        };

        await writeExtractionCache({
          sourcePath,
          book: extracted,
          writeJson: async (cachePath, payload) => {
            await workerCall("_write_file", {
              path: cachePath,
              content: JSON.stringify(payload),
            });
          },
        });
      }

      setBook(extracted);
      setSelectedChapters(new Set(extracted.chapters.map((c) => c.id)));
      setProgress(10);

      db.createBook({
        id: extracted.bookId,
        title: extracted.title,
        sourcePath,
        workDir: extracted.workDir,
      }).catch(() => {});

      // Restore previously analyzed chapters
      try {
        const existing = await db.getChaptersWithScripts(extracted.bookId);
        if (existing.length > 0) {
          const preAnalyzed = new Set(existing.map((c) => c.id));
          setSelectedChapters(
            (prev) => new Set([...prev].filter((c) => !preAnalyzed.has(c))),
          );
          setProgress(20);
          setAnalyzeProgress(
            `Restored ${existing.length} previously analyzed chapter(s).`,
          );

          const restoredScripts: Record<string, string> = {};
          const restoredChars: CharacterMeta[] = [];
          const restoredVoices: AnalysisState["voices"] = [];
          const seenIds = new Set<string>();
          for (const ch of existing) {
            restoredScripts[ch.id] = ch.scriptPath;
            try {
              const raw = await invoke<string>("run_worker", {
                command: "_read_file",
                inputJson: JSON.stringify({ path: ch.scriptPath }),
              }).catch(() => "{}");
              const data = JSON.parse(raw) as {
                characters?: CharacterMeta[];
                voices?: AnalysisState["voices"];
              } | null;
              for (const v of data?.voices ?? []) restoredVoices.push(v);
              for (const c of data?.characters ?? []) {
                if (!seenIds.has(c.id)) {
                  seenIds.add(c.id);
                  restoredChars.push(c);
                }
              }
            } catch {
              // skip unreadable scripts
            }
          }
          setAnalysis({
            characters: restoredChars,
            voices: restoredVoices,
            scriptPaths: restoredScripts,
          });
        }
      } catch {
        // non-critical: skip restoration on error
      }

      try {
        const rightsResult = await workerCall("check_rights", {
          bookPath: path,
          metadata: {},
        });
        if (rightsResult.status === "succeeded") {
          setRights({
            classification: rightsResult.classification as string,
            reason: rightsResult.reason as string,
            requiresAttestation: rightsResult.requiresAttestation as boolean,
            evidence: rightsResult.evidence as string[],
          });
        }
      } catch {
        setRights({
          classification: "unknown",
          reason: "check_failed",
          requiresAttestation: true,
          evidence: [],
        });
      }

      setStage("idle");
      setCurrentStep(2);
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }, [
    abortRef,
    correctionsStore,
    db,
    setAnalysis,
    setAnalyzeProgress,
    setBook,
    setChapterAudioPaths,
    setChapterStatuses,
    setCurrentStep,
    setError,
    setProgress,
    setProgressDetail,
    setRights,
    setRightsAttested,
    setSavedMessage,
    setSelectedChapters,
    setStage,
  ]);

  return { handleImportBook };
}
