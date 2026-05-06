import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";

import type {
  AnalysisState,
  BookState,
  CharacterMeta,
  ChapterMeta,
  PipelineStage,
  ProgressDetail,
  RightsResult,
  WorkspaceStep,
} from "./types";
import { workerCall } from "./lib/workerCall";
import { createCorrectionsStore } from "./state/corrections";
import { Sidebar } from "./components/Sidebar";
import { Step1Import } from "./components/steps/Step1Import";
import { Step2Analyze } from "./components/steps/Step2Analyze";
import { Step3Review } from "./components/steps/Step3Review";
import { Step4Generate } from "./components/steps/Step4Generate";
import { StepDone } from "./components/steps/StepDone";

const VOICE_OPTIONS = [
  { id: "narrator_default", displayName: "Default Narrator" },
  { id: "female_adult_01", displayName: "Female Adult 01" },
  { id: "male_adult_01", displayName: "Male Adult 01" },
  { id: "neutral_dialogue_01", displayName: "Neutral Dialogue 01" },
];

// Module-level singleton: one store per app session.
const correctionsStore = createCorrectionsStore();

export function App() {
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

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleImportBook() {
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

    try {
      const tmp = await tempDir();
      const bookStem =
        (path as string).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "book";
      const workDir = `${tmp}/audiobook-generator/${bookStem}`;

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

      const extracted: BookState = {
        title: artifact.metadata.title,
        bookId: bookStem,
        workDir,
        chapters: artifact.metadata.chapters,
      };
      setBook(extracted);
      setSelectedChapters(new Set(extracted.chapters.map((c) => c.id)));
      setProgress(10);

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
  }

  async function handleAnalyze() {
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
          { label: "Progress", value: `Chapter ${i + 1} of ${chaptersToAnalyze.length}` },
          {
            label: "Current",
            value:
              chapter.title.length > 30
                ? chapter.title.slice(0, 30) + "..."
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

      const doneCount = Object.values(statuses).filter((s) => s === "done").length;
      const wasStopped = controller.signal.aborted;

      if (doneCount > 0) {
        setAnalysis({ characters: allCharacters, voices: allVoices, scriptPaths: scripts });
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
  }

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
          characters?: CharacterMeta[];
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

  async function handleGenerate() {
    if (!book || !analysis) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage("generating");
    setError(null);
    setAnalyzeProgress("");

    const chaptersToGenerate = (
      correctionState.affectedChapters.length > 0
        ? book.chapters.filter((c) =>
            correctionState.affectedChapters.includes(c.id),
          )
        : book.chapters
    ).filter((c) => selectedChapters.has(c.id) && analysis.scriptPaths[c.id]);

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

        setAnalyzeProgress(`Synthesizing chapter ${ci + 1} of ${chaptersToGenerate.length}...`);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        flushSync(() => {
          setProgress(40 + Math.round((ci / chaptersToGenerate.length) * 50));
          setProgressDetail([
            { label: "Backend", value: "Parler TTS (MPS)" },
            { label: "Chapter", value: `${ci + 1} of ${chaptersToGenerate.length}` },
            { label: "Elapsed", value: `${elapsed}s` },
          ]);
        });

        try {
          await workerCall("synthesize_chapter_audio", {
            scriptPath,
            outputDirectory: segDir,
            backend: "parler",
          });
        } catch {
          // chapter synthesis failure is non-fatal
        }

        const result = await workerCall("assemble_chapter_audio", {
          segmentAudioDirectory: segDir,
          outputPath: assembledPath,
        });

        if (result.status === "succeeded") {
          newAudioPaths[chapter.id] = assembledPath;
        }
      }

      setChapterAudioPaths((prev) => ({ ...prev, ...newAudioPaths }));
      const wasStopped = controller.signal.aborted;
      setProgress(wasStopped ? progress : 100);
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
  }

  const handleGenderChange = useCallback((characterId: string, gender: string) => {
    correctionsStore.setGender(characterId, gender);
    setSavedMessage(null);
  }, []);

  const handleVoiceChange = useCallback((characterId: string, voiceId: string) => {
    correctionsStore.setVoice(characterId, voiceId);
    setSavedMessage(null);
  }, []);

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
      return allSelected
        ? new Set<string>()
        : new Set(book.chapters.map((c) => c.id));
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

  // ── Render ───────────────────────────────────────────────────────────────

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
          <Step1Import
            book={book}
            rights={rights}
            rightsAttested={rightsAttested}
            isBusy={isBusy}
            isImporting={stage === "importing"}
            onImport={handleImportBook}
            onAttest={setRightsAttested}
            onContinue={() => setCurrentStep(2)}
          />
        )}
        {currentStep === 2 && book && (
          <Step2Analyze
            book={book}
            analysis={analysis}
            rights={rights}
            rightsAttested={rightsAttested}
            isBusy={isBusy}
            isAnalyzing={stage === "analyzing"}
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
          <Step3Review
            analysis={analysis}
            correctionState={correctionState}
            savedMessage={savedMessage}
            isBusy={isBusy}
            isSaving={stage === "saving"}
            voices={VOICE_OPTIONS}
            onSave={handleSaveCorrections}
            onContinue={() => setCurrentStep(4)}
            onGenderChange={handleGenderChange}
            onVoiceChange={handleVoiceChange}
          />
        )}
        {currentStep === 4 && book && analysis && (
          <Step4Generate
            book={book}
            analysis={analysis}
            selectedChapters={selectedChapters}
            correctionDirty={correctionState.dirty}
            chapterAudioPaths={chapterAudioPaths}
            isBusy={isBusy}
            isGenerating={stage === "generating"}
            analyzeProgress={analyzeProgress}
            progressDetail={progressDetail}
            progress={progress}
            onGenerate={handleGenerate}
            onContinue={() => setCurrentStep("done")}
          />
        )}
        {currentStep === "done" && book && (
          <StepDone
            book={book}
            chapterAudioPaths={chapterAudioPaths}
            analysis={analysis}
            savedMessage={savedMessage}
            onSaveChapter={handleSaveChapter}
          />
        )}
      </section>
    </main>
  );
}
