import { useState, useSyncExternalStore, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tmpdir } from "@tauri-apps/api/path";
import { CharacterTable } from "./components/CharacterTable";
import {
  createCorrectionsStore,
} from "./state/corrections";

interface ChapterMeta {
  id: string;
  title: string;
  textLength: number;
  textPath: string;
}

interface CharacterMeta {
  id: string;
  canonicalName: string;
  aliases: string[];
  gender: string;
  voiceId: string;
  confidence: number;
}

interface VoiceMeta {
  id: string;
  displayName: string;
  backend: string;
}

interface BookState {
  title: string;
  bookId: string;
  workDir: string;
  chapters: ChapterMeta[];
}

interface AnalysisState {
  characters: CharacterMeta[];
  voices: VoiceMeta[];
  scriptPaths: Record<string, string>;
}

type PipelineStage = "idle" | "importing" | "analyzing" | "saving" | "generating" | "done" | "error";

const correctionsStore = createCorrectionsStore();

const VOICE_DISPLAY_NAMES: Record<string, string> = {
  narrator_default: "Default Narrator",
  female_adult_01: "Female Adult 01",
  male_adult_01: "Male Adult 01",
  neutral_dialogue_01: "Neutral Dialogue 01",
};

const VOICE_OPTIONS = Object.entries(VOICE_DISPLAY_NAMES).map(([id, displayName]) => ({ id, displayName }));

async function workerCall(command: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await invoke<string>("run_worker", {
    command,
    inputJson: JSON.stringify(input),
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

export function App() {
  const [book, setBook] = useState<BookState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const correctionState = useSyncExternalStore(
    correctionsStore.subscribe,
    correctionsStore.get,
  );

  async function handleImportBook() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Book", extensions: ["epub", "pdf"] }],
    });
    if (!path) return;

    setStage("importing");
    setError(null);
    setAnalysis(null);
    setAudioPath(null);
    correctionsStore.reset();

    try {
      const tmp = await tmpdir();
      const bookStem = (path as string).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "book";
      const workDir = `${tmp}/audiobook-generator/${bookStem}`;

      const result = await workerCall("extract_book", {
        bookPath: path,
        outputDirectory: `${workDir}/chapters`,
      });

      if (result.status !== "succeeded") {
        const err = result.error as { message: string } | undefined;
        throw new Error(err?.message ?? "extract_book failed");
      }

      const artifact = (result.artifacts as Array<{ metadata: { title: string; chapters: ChapterMeta[] } }>)[0];
      setBook({
        title: artifact.metadata.title,
        bookId: bookStem,
        workDir,
        chapters: artifact.metadata.chapters,
      });
      setProgress(10);
      setStage("idle");
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }

  async function handleAnalyze() {
    if (!book) return;
    setStage("analyzing");
    setError(null);
    setSavedMessage(null);

    try {
      const scriptDir = `${book.workDir}/scripts`;
      const scripts: Record<string, string> = {};
      const allCharacters: CharacterMeta[] = [];
      const allVoices: VoiceMeta[] = [];
      const seenIds = new Set<string>();
      const seenVoiceIds = new Set<string>();

      for (let i = 0; i < book.chapters.length; i++) {
        const chapter = book.chapters[i];
        setProgress(10 + Math.round((i / book.chapters.length) * 30));

        const result = await workerCall("analyze_chapter", {
          bookId: book.bookId,
          chapterId: chapter.id,
          title: chapter.title,
          chapterTextPath: chapter.textPath,
          outputDirectory: scriptDir,
          mockLlm: true,
        });

        if (result.status !== "succeeded") continue;

        const artifact = (result.artifacts as Array<{ path: string }>)[0];
        scripts[chapter.id] = artifact.path;

        const scriptRaw = await invoke<string>("run_worker", {
          command: "_read_file",
          inputJson: JSON.stringify({ path: artifact.path }),
        }).catch(() => "{}");
        const scriptData = JSON.parse(scriptRaw) as {
          characters?: CharacterMeta[];
          voices?: VoiceMeta[];
        } | null;

        if (scriptData?.voices) {
          for (const v of scriptData.voices) {
            if (!seenVoiceIds.has(v.id)) {
              seenVoiceIds.add(v.id);
              allVoices.push(v);
            }
          }
        }

        if (scriptData?.characters) {
          for (const c of scriptData.characters) {
            if (!seenIds.has(c.id)) {
              seenIds.add(c.id);
              allCharacters.push(c);
            }
          }
        }
      }

      setAnalysis({ characters: allCharacters, voices: allVoices, scriptPaths: scripts });
      setProgress(40);
      setStage("idle");
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }

  async function handleSaveCorrections() {
    if (!book || !analysis) return;
    setStage("saving");
    setError(null);
    setSavedMessage(null);

    try {
      const chaptersInput = book.chapters.map((c) => ({
        chapterId: c.id,
        textPath: c.textPath,
        title: c.title,
      }));

      const result = await workerCall("apply_corrections", {
        bookId: book.bookId,
        chapters: chaptersInput,
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

      const artifacts = result.artifacts as Array<{ path: string; metadata: { chapterId: string } }>;
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
          voices?: VoiceMeta[];
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
    } catch (err) {
      setError(String(err));
      setStage("error");
    }
  }

  async function handleGenerate() {
    if (!book || !analysis) return;
    setStage("generating");
    setError(null);

    const chaptersToGenerate = correctionState.affectedChapters.length > 0
      ? book.chapters.filter((c) => correctionState.affectedChapters.includes(c.id))
      : book.chapters;

    try {
      let generatedPath: string | null = null;
      for (let ci = 0; ci < chaptersToGenerate.length; ci++) {
        const chapter = chaptersToGenerate[ci];
        const scriptPath = analysis.scriptPaths[chapter.id];
        if (!scriptPath) continue;

        const segDir = `${book.workDir}/segments/${chapter.id}`;
        const assembledPath = `${book.workDir}/audio/${chapter.id}.wav`;

        const scriptRaw = await invoke<string>("run_worker", {
          command: "_read_file",
          inputJson: JSON.stringify({ path: scriptPath }),
        }).catch(() => "{}");
        const script = JSON.parse(scriptRaw) as { segments?: Array<{ id: string }> };
        const segments = script.segments ?? [];

        for (let i = 0; i < segments.length; i++) {
          setProgress(40 + Math.round(((ci * segments.length + i) / (chaptersToGenerate.length * segments.length)) * 50));
          await workerCall("synthesize_segment_audio", {
            scriptPath,
            segmentId: segments[i].id,
            outputDirectory: segDir,
            backend: "parler",
          });
        }

        const result = await workerCall("assemble_chapter_audio", {
          segmentAudioDirectory: segDir,
          outputPath: assembledPath,
        });

        if (result.status === "succeeded") {
          generatedPath = assembledPath;
        }
      }

      if (generatedPath) setAudioPath(generatedPath);
      setProgress(100);
      setStage("done");
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
    setSavedMessage(null);
  }, []);

  const isBusy = stage === "importing" || stage === "analyzing" || stage === "saving" || stage === "generating";

  const steps = [
    { label: "Import", status: book ? "Done" : stage === "importing" ? "Running..." : "Ready" },
    { label: "Analyze", status: analysis ? "Done" : stage === "analyzing" ? "Running..." : book ? "Ready" : "Waiting" },
    { label: "Review", status: correctionState.savedCorrections ? "Done" : analysis ? "Ready" : "Waiting" },
    { label: "Generate", status: stage === "done" ? "Done" : stage === "generating" ? "Running..." : analysis ? "Ready" : "Waiting" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <h1>Audiobook Generator</h1>
        <button
          className="primary-action"
          type="button"
          onClick={handleImportBook}
          disabled={isBusy}
        >
          {stage === "importing" ? "Importing..." : "Import Book"}
        </button>
        {book && !analysis && (
          <button
            className="primary-action"
            type="button"
            onClick={handleAnalyze}
            disabled={stage === "analyzing"}
            style={{ marginTop: 8 }}
          >
            {stage === "analyzing" ? "Analyzing..." : "Analyze Book"}
          </button>
        )}
        {analysis && (
          <button
            className="primary-action"
            type="button"
            onClick={handleSaveCorrections}
            disabled={!correctionState.dirty || stage === "saving"}
            style={{ marginTop: 8 }}
          >
            {stage === "saving" ? "Saving..." : "Save Corrections"}
          </button>
        )}
        {correctionState.savedCorrections && (
          <button
            className="primary-action"
            type="button"
            onClick={handleGenerate}
            disabled={stage === "generating"}
            style={{ marginTop: 8 }}
          >
            {stage === "generating" ? "Generating..." : "Regenerate Affected Chapters"}
          </button>
        )}
        <nav aria-label="Workflow">
          {steps.map((step) => (
            <div className="workflow-step" key={step.label}>
              <span>{step.label}</span>
              <small>{step.status}</small>
            </div>
          ))}
        </nav>
      </aside>

      <section className="workspace" aria-label="Audiobook job">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Local desktop pipeline</p>
            <h2>Job Progress</h2>
          </div>
          <span className="status-pill">{book ? book.title : "No active book"}</span>
        </header>

        <section className="progress-panel" aria-label="Pipeline progress">
          {stage === "error" ? (
            <div>
              <strong>Error</strong>
              <p>{error}</p>
            </div>
          ) : stage === "done" ? (
            <div>
              <strong>Done!</strong>
              <p>Chapter audio saved to: {audioPath}</p>
            </div>
          ) : book ? (
            <div>
              <strong>{book.title}</strong>
              <p>
                {book.chapters.length} chapter{book.chapters.length !== 1 ? "s" : ""} detected.
                {analysis ? ` ${analysis.characters.length} character${analysis.characters.length !== 1 ? "s" : ""} identified.` : ""}
              </p>
            </div>
          ) : (
            <div>
              <strong>Import a PDF or EPUB to begin.</strong>
              <p>Extraction, chapter detection, dialogue analysis, and local TTS run as resumable stages.</p>
            </div>
          )}
          <progress value={progress} max="100" aria-label="Generation progress" />
        </section>

        <section className="grid">
          <article>
            <h3>Characters</h3>
            {analysis && analysis.characters.length > 0 ? (
              <ul>
                {analysis.characters.map((c) => (
                  <li key={c.id}>
                    {c.canonicalName} <small>({c.gender} · {c.voiceId})</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Detected speakers, gender confidence, aliases, and assigned voices will appear here.</p>
            )}
          </article>
          <article>
            <h3>Chapters</h3>
            {book && book.chapters.length > 0 ? (
              <ul>
                {book.chapters.slice(0, 10).map((c) => (
                  <li key={c.id}>
                    {c.title}
                    {analysis?.scriptPaths[c.id] ? " ✓" : ""}
                    {correctionState.affectedChapters.includes(c.id) ? " (pending regeneration)" : ""}
                    <small> ({Math.round(c.textLength / 1000)}k chars)</small>
                  </li>
                ))}
                {book.chapters.length > 10 && <li>...and {book.chapters.length - 10} more</li>}
              </ul>
            ) : (
              <p>Chapter scripts and generation state will be listed as the worker pipeline runs.</p>
            )}
          </article>
          <article>
            <h3>Rights</h3>
            <p>Unknown or restricted license status will require confirmation before generation.</p>
            <label className="attestation">
              <input type="checkbox" />
              <span>I have the right to convert this book</span>
            </label>
          </article>
          <article className="review-panel">
            <h3>Review</h3>
            {savedMessage && <p className="saved-message">{savedMessage}</p>}
            {analysis ? (
              <>
                <CharacterTable
                  characters={analysis.characters}
                  voices={VOICE_OPTIONS}
                  onGenderChange={handleGenderChange}
                  onVoiceChange={handleVoiceChange}
                />
                {correctionState.dirty && (
                  <p className="hint">You have unsaved corrections. Click "Save Corrections" to apply them.</p>
                )}
              </>
            ) : (
              <p>Run analysis first to see the character table and make corrections.</p>
            )}
          </article>
          <article>
            <h3>Export</h3>
            {audioPath ? (
              <p>Chapter audio ready: <code>{audioPath}</code></p>
            ) : (
              <p>Completed chapter audio and metadata exports will be available after generation.</p>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}
