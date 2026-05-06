import { useState, useSyncExternalStore, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";
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

interface RightsResult {
  classification: string;
  reason: string;
  requiresAttestation: boolean;
  evidence: string[];
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
  const [rights, setRights] = useState<RightsResult | null>(null);
  const [rightsAttested, setRightsAttested] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<string>("");
  const [chapterStatuses, setChapterStatuses] = useState<Record<string, string>>({});
  const [progressDetail, setProgressDetail] = useState<Array<{ label: string; value: string }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());

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

    abortRef.current?.abort();
    setStage("importing");
    setError(null);
    setAnalysis(null);
    setAudioPath(null);
    setRights(null);
    setRightsAttested(false);
    correctionsStore.reset();
    setAnalyzeProgress("");
    setChapterStatuses({});
    setProgressDetail([]);

    try {
      const tmp = await tempDir();
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
      setSelectedChapters(new Set(artifact.metadata.chapters.map((c: ChapterMeta) => c.id)));
      setProgress(10);

      // Check rights
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
        setRights({ classification: "unknown", reason: "check_failed", requiresAttestation: true, evidence: [] });
      }

      setStage("idle");
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
      const allVoices: VoiceMeta[] = [];
      const seenIds = new Set<string>();
      const seenVoiceIds = new Set<string>();
      const statuses: Record<string, string> = {};

      const chaptersToAnalyze = book.chapters.filter(c => selectedChapters.has(c.id) && !analysis?.scriptPaths[c.id]);
      for (let i = 0; i < chaptersToAnalyze.length; i++) {
        if (controller.signal.aborted) break;
        const chapter = chaptersToAnalyze[i];
        setProgress(10 + Math.round((i / chaptersToAnalyze.length) * 25));
        setAnalyzeProgress(`Analyzing chapter ${i + 1} of ${chaptersToAnalyze.length} using ${modelLabel}...`);
        setProgressDetail([
          { label: "Model", value: modelLabel },
          { label: "Progress", value: `Chapter ${i + 1} of ${chaptersToAnalyze.length}` },
          { label: "Current", value: chapter.title.length > 30 ? chapter.title.slice(0, 30) + "..." : chapter.title },
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
        } catch {
          statuses[chapter.id] = "failed";
        }

        setChapterStatuses({ ...statuses });
      }

      const doneCount = Object.values(statuses).filter(s => s === "done").length;
      const wasStopped = controller.signal.aborted;
      if (doneCount > 0) {
        setAnalysis({ characters: allCharacters, voices: allVoices, scriptPaths: scripts });
      }
      setAnalyzeProgress(wasStopped
        ? `Stopped after ${doneCount} of ${chaptersToAnalyze.length} chapters. ${doneCount > 0 ? "You can generate audio for completed chapters." : ""}`
        : `Analysis complete: ${doneCount} of ${book.chapters.length} chapters analyzed.`);
      setProgress(wasStopped ? 40 : 40);
      setStage("idle");
      abortRef.current = null;
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

    const chaptersToGenerate = (correctionState.affectedChapters.length > 0
      ? book.chapters.filter((c) => correctionState.affectedChapters.includes(c.id))
      : book.chapters).filter(c => selectedChapters.has(c.id) && analysis.scriptPaths[c.id]);

    try {
      let generatedPath: string | null = null;
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
        const script = JSON.parse(scriptRaw) as { segments?: Array<{ id: string; voiceId?: string; emotion?: string }> };
        const segments = script.segments ?? [];

        setAnalyzeProgress(`Synthesizing chapter ${ci + 1} of ${chaptersToGenerate.length} (${segments.length} segments)...`);
        totalSegments += segments.length;

        for (let i = 0; i < segments.length; i++) {
          if (controller.signal.aborted) break;
          setProgress(40 + Math.round(((doneSegments + i) / Math.max(totalSegments, 1)) * 50));
          if (segments[i]) {
            setProgressDetail([
              { label: "Backend", value: "Parler TTS (MPS)" },
              { label: "Chapter", value: `${ci + 1} of ${chaptersToGenerate.length}` },
              { label: "Segment", value: `${i + 1} of ${segments.length}` },
              { label: "Voice", value: segments[i].voiceId || "—" },
              { label: "Emotion", value: segments[i].emotion || "neutral" },
              { label: "Elapsed", value: `${Math.round((Date.now() - startTime) / 1000)}s` },
            ]);
          }
          try {
            await workerCall("synthesize_segment_audio", {
              scriptPath,
              segmentId: segments[i].id,
              outputDirectory: segDir,
              backend: "parler",
            });
          } catch {
            // Individual segment failure doesn't stop the chapter
          }
          doneSegments++;
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
      const wasStopped = controller.signal.aborted;
      setProgress(wasStopped ? Math.round(progress) : 100);
      setAnalyzeProgress(wasStopped ? "Generation stopped. Partial audio available." : "Audio generation complete.");
      setStage(wasStopped && generatedPath ? "done" : wasStopped ? "idle" : "done");
      abortRef.current = null;
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
    setSelectedChapters(prev => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }

  function toggleAllChapters() {
    if (!book) return;
    setSelectedChapters(prev => {
      const allSelected = book.chapters.length > 0 && book.chapters.every(c => prev.has(c.id));
      if (allSelected) return new Set();
      return new Set(book.chapters.map(c => c.id));
    });
  }

  const allChaptersSelected = book ? book.chapters.length > 0 && book.chapters.every(c => selectedChapters.has(c.id)) : false;

  function handleStop() {
    abortRef.current?.abort();
    setAnalyzeProgress("Stopping...");
  }

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
        {isBusy && (
          <button
            className="stop-action"
            type="button"
            onClick={handleStop}
            style={{ marginTop: 8 }}
          >
            Stop
          </button>
        )}
        {book && !analysis && rights?.classification !== "blocked" && (
          <button
            className="primary-action"
            type="button"
            onClick={handleAnalyze}
            disabled={stage === "analyzing" || (rights?.requiresAttestation && !rightsAttested)}
            style={{ marginTop: 8 }}
          >
            {stage === "analyzing" ? "Analyzing..." : rights?.requiresAttestation && !rightsAttested ? "Attest rights first" : `Analyze${analysis ? " Selected" : " Book"}${selectedChapters.size < (book?.chapters.length || 0) ? ` (${selectedChapters.size})` : ""}`}
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
            {stage === "generating" ? "Generating..." : `Generate${correctionState.savedCorrections ? " Affected" : ""} Chapters${selectedChapters.size < (book?.chapters.length || 0) ? ` (${selectedChapters.size})` : ""}`}
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
              <button className="secondary-action" type="button" onClick={() => setStage("idle")} style={{ marginTop: 8, width: "auto", padding: "6px 14px" }}>
                Dismiss
              </button>
            </div>
          ) : stage === "done" ? (
            <div>
              <strong>Done!</strong>
              <p>{analyzeProgress || "Chapter audio generated."}</p>
              {audioPath && <p><code className="export-path">{audioPath}</code></p>}
            </div>
          ) : book ? (
            <div>
              <strong>{book.title}</strong>
              <p>
                {book.chapters.length} chapter{book.chapters.length !== 1 ? "s" : ""}
                {analysis ? ` · ${analysis.characters.length} character${analysis.characters.length !== 1 ? "s" : ""}` : ""}
              </p>
              {analyzeProgress && <p className="analyze-progress">{analyzeProgress}</p>}
              {progressDetail.length > 0 && stage !== "idle" && (
                <div className="progress-detail">
                  {progressDetail.map((d) => (
                    <span key={d.label} className="progress-detail-item">
                      <strong>{d.label}</strong> {d.value}
                    </span>
                  ))}
                </div>
              )}
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
              <>
                <label className="select-all" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8125rem", marginBottom: 8, color: "#435160" }}>
                  <input
                    type="checkbox"
                    checked={allChaptersSelected}
                    onChange={toggleAllChapters}
                    disabled={isBusy}
                  />
                  {allChaptersSelected ? "Deselect all" : "Select all"} · {selectedChapters.size}/{book.chapters.length}
                </label>
                <ul className="chapter-list">
                  {book.chapters.slice(0, 10).map((c) => (
                    <li key={c.id} className={!analysis?.scriptPaths[c.id] && chapterStatuses[c.id] === "failed" ? "chapter-failed" : ""}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selectedChapters.has(c.id)}
                          onChange={() => toggleChapter(c.id)}
                          disabled={isBusy}
                        />
                        <span>
                          {c.title}
                          {analysis?.scriptPaths[c.id] ? " ✓" : chapterStatuses[c.id] === "analyzing" ? " ⏳" : chapterStatuses[c.id] === "failed" ? " ✗" : ""}
                          {correctionState.affectedChapters.includes(c.id) ? " (pending regeneration)" : ""}
                          <small> ({Math.round(c.textLength / 1000)}k chars)</small>
                        </span>
                      </label>
                    </li>
                  ))}
                  {book.chapters.length > 10 && <li>...and {book.chapters.length - 10} more</li>}
                </ul>
              </>
            ) : (
              <p>Chapter scripts and generation state will be listed as the worker pipeline runs.</p>
            )}
          </article>
          <article>
            <h3>Rights</h3>
            {rights ? (
              <>
                <p className={`rights-badge rights-${rights.classification}`}>
                  {rights.classification.toUpperCase()}
                  {rights.classification === "blocked" && " — Cannot proceed"}
                </p>
                <p className="rights-reason">{rights.reason.replace(/_/g, " ")}</p>
                {rights.requiresAttestation && (
                  <label className="attestation">
                    <input
                      type="checkbox"
                      checked={rightsAttested}
                      onChange={(e) => setRightsAttested(e.target.checked)}
                    />
                    <span>I have the right to convert this book</span>
                  </label>
                )}
              </>
            ) : (
              <>
                <p>Unknown or restricted license status will require confirmation before generation.</p>
                <label className="attestation">
                  <input type="checkbox" disabled />
                  <span>I have the right to convert this book</span>
                </label>
              </>
            )}
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
              <>
                <p>Chapter audio ready:</p>
                <code className="export-path">{audioPath}</code>
                <button
                  className="primary-action"
                  type="button"
                  onClick={async () => {
                    try {
                      const savePath = await open({
                        multiple: false,
                        defaultPath: "chapter.wav",
                        filters: [{ name: "Audio", extensions: ["wav"] }],
                      });
                      if (!savePath) return;
                      await invoke("copy_file", { from: audioPath, to: savePath as string });
                      setSavedMessage(`Saved to ${savePath}`);
                    } catch (err) {
                      setError(String(err));
                    }
                  }}
                  style={{ marginTop: 12 }}
                >
                  Save Audio File
                </button>
              </>
            ) : (
              <p>Completed chapter audio and metadata exports will be available after generation.</p>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}
