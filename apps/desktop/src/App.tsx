import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type {
  AnalysisState,
  BookState,
  ChapterMeta,
  PipelineStage,
  ProgressDetail,
  RightsResult,
  WorkspaceStep,
} from "./types";
import { workerCall } from "./lib/workerCall";
import { createCorrectionsStore } from "./state/corrections";
import { createAudiobookStore } from "./state/store";
import { useBookImport } from "./hooks/useBookImport";
import { useChapterAnalysis } from "./hooks/useChapterAnalysis";
import { useGeneration } from "./hooks/useGeneration";
import { Sidebar } from "./components/Sidebar";
import { ImportContainer } from "./components/containers/ImportContainer";
import { AnalyzeContainer } from "./components/containers/AnalyzeContainer";
import { ReviewContainer } from "./components/containers/ReviewContainer";
import { GenerateContainer } from "./components/containers/GenerateContainer";
import { DoneContainer } from "./components/containers/DoneContainer";

const db = createAudiobookStore();

const VOICE_OPTIONS = [
  { id: "narrator_default", displayName: "Default Narrator" },
  { id: "female_adult_01", displayName: "Female Adult 01" },
  { id: "male_adult_01", displayName: "Male Adult 01" },
  { id: "neutral_dialogue_01", displayName: "Neutral Dialogue 01" },
];

const correctionsStore = createCorrectionsStore();

export function App() {
  // ── Pipeline state ──────────────────────────────────────────────────────
  const [book, setBook] = useState<BookState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [chapterAudioPaths, setChapterAudioPaths] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [rights, setRights] = useState<RightsResult | null>(null);
  const [rightsAttested, setRightsAttested] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState("");
  const [chapterStatuses, setChapterStatuses] = useState<Record<string, string>>({});
  const [progressDetail, setProgressDetail] = useState<ProgressDetail[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [currentStep, setCurrentStep] = useState<WorkspaceStep>(1);

  const abortRef = useRef<AbortController | null>(null);

  const correctionState = useSyncExternalStore(
    correctionsStore.subscribe,
    correctionsStore.get,
  );

  const isBusy =
    stage === "importing" ||
    stage === "analyzing" ||
    stage === "saving" ||
    stage === "generating";

  // ── Hooks ───────────────────────────────────────────────────────────────

  const { handleImportBook } = useBookImport({
    setBook, setAnalysis, setChapterAudioPaths, setStage, setError, setProgress,
    setRights, setRightsAttested, setAnalyzeProgress, setChapterStatuses,
    setProgressDetail, setSelectedChapters, setCurrentStep, setSavedMessage,
    abortRef, correctionsStore, db,
  });

  const { handleAnalyze } = useChapterAnalysis({
    book, selectedChapters, setStage, setError, setSavedMessage,
    setAnalyzeProgress, setChapterStatuses, setProgressDetail, setProgress,
    setAnalysis, setCurrentStep, abortRef, db,
  });

  const { handleGenerate, handleRegenerateChapter, handleRegenerateAll } =
    useGeneration({
      book, analysis, selectedChapters, chapterAudioPaths, correctionState,
      setStage, setError, setAnalyzeProgress, setProgressDetail, setProgress,
      setChapterAudioPaths, setCurrentStep, abortRef,
    });

  // ── Corrections ─────────────────────────────────────────────────────────

  async function handleSaveCorrections() {
    if (!book || !analysis) return;
    setStage("saving");
    setError(null);
    setSavedMessage(null);

    try {
      const result = await workerCall("apply_corrections", {
        bookId: book.bookId,
        chapters: book.chapters.map((c) => ({
          chapterId: c.id,
          textPath: c.textPath,
          title: c.title,
        })),
        corrections: {
          aliasMerges: correctionState.aliasMerges,
          genderOverrides: correctionState.genderOverrides,
          voiceOverrides: correctionState.voiceOverrides,
        },
        outputDirectory: `${book.workDir}/scripts`,
        language: "en",
      });

      if (result.status !== "succeeded") {
        const err = result.error as { message: string } | undefined;
        throw new Error(err?.message ?? "apply_corrections failed");
      }

      const artifacts = result.artifacts as Array<{
        path: string;
        metadata: { chapterId: string };
      }>;
      const newScriptPaths = { ...analysis.scriptPaths };
      const affectedIds: string[] = [];

      for (const art of artifacts) {
        newScriptPaths[art.metadata.chapterId] = art.path;
        affectedIds.push(art.metadata.chapterId);
      }

      if (artifacts.length > 0) {
        const firstScriptRaw = await invoke<string>("run_worker", {
          command: "_read_file",
          inputJson: JSON.stringify({ path: artifacts[0].path }),
        }).catch(() => "{}");

        const firstScript = JSON.parse(firstScriptRaw) as {
          characters?: import("./types").CharacterMeta[];
          voices?: AnalysisState["voices"];
        } | null;

        if (firstScript?.characters) {
          const updatedIds = new Set(firstScript.characters.map((c) => c.id));
          const preserved = analysis.characters.filter((c) => !updatedIds.has(c.id));
          setAnalysis({
            ...analysis,
            scriptPaths: newScriptPaths,
            characters: [...preserved, ...firstScript.characters],
          });
        } else {
          setAnalysis({ ...analysis, scriptPaths: newScriptPaths });
        }
      }

      correctionsStore.markSaved(affectedIds);
      setSavedMessage(`Corrections saved. ${affectedIds.length} chapter(s) updated.`);
      setStage("idle");
      setCurrentStep(4);
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }

  const handleGenderChange = useCallback((characterId: string, gender: string) => {
    correctionsStore.setGender(characterId, gender);
    setSavedMessage(null);
  }, []);

  const handleVoiceChange = useCallback((characterId: string, voiceId: string) => {
    correctionsStore.setVoice(characterId, voiceId);
    setAnalysis((current) => {
      if (!current) return current;
      return {
        ...current,
        characters: current.characters.map((c) =>
          c.id === characterId ? { ...c, voiceId } : c,
        ),
      };
    });
    setSavedMessage(null);
  }, []);

  async function handlePreviewVoice(voiceId: string) {
    if (!book) return;
    try {
      setSavedMessage(`Generating ${voiceId} preview...`);
      const previewDir = `${book.workDir}/voice-previews`;
      const scriptPath = `${previewDir}/${voiceId}.json`;
      const script = {
        bookId: book.bookId,
        chapterId: "voice_preview",
        segments: [{
          id: `preview_${voiceId}`,
          text: "This is a voice preview.",
          voiceId,
          emotion: "neutral",
          intensity: 0.2,
          pace: "normal",
        }],
      };

      await workerCall("_write_file", { path: scriptPath, content: JSON.stringify(script) });
      const result = await workerCall("synthesize_segment_audio", {
        scriptPath,
        segmentId: `preview_${voiceId}`,
        outputDirectory: previewDir,
        backend: "parler",
      });

      if (result.status !== "succeeded") {
        const err = result.error as { message: string } | undefined;
        throw new Error(err?.message ?? "voice preview failed");
      }

      const artifact = (result.artifacts as Array<{ path: string }>)[0];
      await new Audio(convertFileSrc(artifact.path)).play();
      setSavedMessage(`Playing ${voiceId} preview.`);
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }

  // ── Chapter selection ───────────────────────────────────────────────────

  function toggleChapter(chapterId: string) {
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }

  function toggleAllChapters() {
    if (!book) return;
    setSelectedChapters((prev) => {
      const allSelected =
        book.chapters.length > 0 && book.chapters.every((c) => prev.has(c.id));
      return allSelected ? new Set<string>() : new Set(book.chapters.map((c) => c.id));
    });
  }

  function handleStop() {
    abortRef.current?.abort();
    setAnalyzeProgress("Stopping...");
  }

  async function handleSaveChapter(chapter: ChapterMeta) {
    const audioPath = chapterAudioPaths[chapter.id];
    if (!audioPath) return;
    try {
      const savePath = await open({
        multiple: false,
        defaultPath: `${chapter.id}.wav`,
        filters: [{ name: "Audio", extensions: ["wav"] }],
      });
      if (!savePath) return;
      await invoke("copy_file", { from: audioPath, to: savePath as string });
      setSavedMessage(`Saved ${chapter.title} to ${savePath}`);
    } catch (err) {
      setError(String(err));
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <main className="app-shell">
      <Sidebar
        currentStep={currentStep}
        book={book}
        analysis={analysis}
        chapterAudioPaths={chapterAudioPaths}
        correctionDirty={correctionState.dirty}
        isBusy={isBusy}
        error={error}
        onNavigate={setCurrentStep}
        onStop={handleStop}
        onDismissError={() => setStage("idle")}
      />

      <section className="workspace" aria-label="Audiobook job">
        {currentStep === 1 && (
          <ImportContainer
            book={book}
            rights={rights}
            rightsAttested={rightsAttested}
            stage={stage}
            isBusy={isBusy}
            onImport={handleImportBook}
            onAttest={setRightsAttested}
            onContinue={() => setCurrentStep(2)}
          />
        )}
        {currentStep === 2 && book && (
          <AnalyzeContainer
            book={book}
            analysis={analysis}
            rights={rights}
            rightsAttested={rightsAttested}
            stage={stage}
            isBusy={isBusy}
            selectedChapters={selectedChapters}
            chapterStatuses={chapterStatuses}
            analyzeProgress={analyzeProgress}
            progressDetail={progressDetail}
            progress={progress}
            onAnalyze={handleAnalyze}
            onToggleChapter={toggleChapter}
            onToggleAll={toggleAllChapters}
            onContinue={() => setCurrentStep(3)}
          />
        )}
        {currentStep === 3 && analysis && (
          <ReviewContainer
            analysis={analysis}
            correctionState={correctionState}
            savedMessage={savedMessage}
            stage={stage}
            isBusy={isBusy}
            voices={VOICE_OPTIONS}
            onSave={handleSaveCorrections}
            onContinue={() => setCurrentStep(4)}
            onGenderChange={handleGenderChange}
            onVoiceChange={handleVoiceChange}
            onPreviewVoice={handlePreviewVoice}
          />
        )}
        {currentStep === 4 && book && analysis && (
          <GenerateContainer
            book={book}
            analysis={analysis}
            selectedChapters={selectedChapters}
            correctionDirty={correctionState.dirty}
            chapterAudioPaths={chapterAudioPaths}
            stage={stage}
            isBusy={isBusy}
            analyzeProgress={analyzeProgress}
            progressDetail={progressDetail}
            progress={progress}
            onGenerate={handleGenerate}
            onContinue={() => setCurrentStep("done")}
          />
        )}
        {currentStep === "done" && book && (
          <DoneContainer
            book={book}
            chapterAudioPaths={chapterAudioPaths}
            analysis={analysis}
            savedMessage={savedMessage}
            isBusy={isBusy}
            onSaveChapter={handleSaveChapter}
            onRegenerateChapter={handleRegenerateChapter}
            onRegenerateAll={handleRegenerateAll}
          />
        )}
      </section>
    </main>
  );
}
