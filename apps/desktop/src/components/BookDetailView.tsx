import { useRef, useCallback, useEffect, useMemo } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AnalysisState,
  BookState,
  ChapterMeta,
  CharacterMeta,
  LibraryBook,
  VoiceMeta,
} from "../types";
import { createAudiobookStore } from "../state/store";
import { useCorrectionStore } from "../state/corrections";
import { usePipelineStore } from "../state/pipelineStore";
import { useChapterAnalysis } from "../hooks/useChapterAnalysis";
import { useGeneration } from "../hooks/useGeneration";
import { workerCall } from "../lib/workerCall";

const db = createAudiobookStore();

const VOICE_OPTIONS = [
  { id: "narrator_default", displayName: "Default Narrator" },
  { id: "female_adult_01", displayName: "Female Adult 01" },
  { id: "male_adult_01", displayName: "Male Adult 01" },
  { id: "neutral_dialogue_01", displayName: "Neutral Dialogue 01" },
];

interface BookDetailViewProps {
  libraryBook: LibraryBook;
  book: BookState;
  onBack: () => void;
}

export function BookDetailView({
  libraryBook,
  book,
  onBack,
}: BookDetailViewProps) {
  const pipeline = usePipelineStore();
  const correctionState = useCorrectionStore();
  const abortRef = useRef<AbortController | null>(null);

  const isBusy =
    pipeline.stage === "importing" ||
    pipeline.stage === "analyzing" ||
    pipeline.stage === "saving" ||
    pipeline.stage === "generating";

  const noopSetCurrentStep = () => {};

  const { handleAnalyze } = useChapterAnalysis({
    book,
    selectedChapters: pipeline.selectedChapters,
    setStage: pipeline.setStage,
    setError: pipeline.setError,
    setSavedMessage: pipeline.setSavedMessage,
    setAnalyzeProgress: pipeline.setAnalyzeProgress,
    setChapterStatuses: pipeline.setChapterStatuses,
    setProgressDetail: pipeline.setProgressDetail,
    setProgress: pipeline.setProgress,
    setAnalysis: pipeline.setAnalysis,
    setCurrentStep: noopSetCurrentStep,
    abortRef,
    db,
  });

  const { handleGenerate, handleRegenerateChapter, handleRegenerateAll } =
    useGeneration({
      book,
      analysis: pipeline.analysis,
      selectedChapters: pipeline.selectedChapters,
      chapterAudioPaths: pipeline.chapterAudioPaths,
      correctionState: correctionState as {
        affectedChapters: string[];
        dirty?: boolean;
      },
      setStage: pipeline.setStage,
      setError: pipeline.setError,
      setAnalyzeProgress: pipeline.setAnalyzeProgress,
      setProgressDetail: pipeline.setProgressDetail,
      setProgress: pipeline.setProgress,
      setChapterAudioPaths: pipeline.setChapterAudioPaths,
      setCurrentStep: noopSetCurrentStep,
      abortRef,
    });

  // Restore saved state on mount
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      // Load characters
      const chars = await db.getCharacters(book.bookId);
      if (cancelled) return;

      if (chars.length > 0) {
        pipeline.setAnalysis({
          characters: chars.map(
            (c): CharacterMeta => ({
              id: c.id,
              canonicalName: c.canonicalName,
              aliases: JSON.parse(c.aliases || "[]"),
              gender: c.gender || "unknown",
              voiceId: c.voiceId || "narrator_default",
              confidence: c.confidence,
            }),
          ),
          voices: [],
          scriptPaths: {},
        });
      }

      // Load scripts (analyzed chapters)
      const chaptersWithScripts = await db.getChaptersWithScripts(book.bookId);
      if (cancelled) return;
      const scriptPaths: Record<string, string> = {};
      for (const ch of chaptersWithScripts) {
        scriptPaths[ch.id] = ch.scriptPath;
      }
      if (Object.keys(scriptPaths).length > 0) {
        pipeline.setAnalysis((prev) => ({
          characters: prev?.characters ?? [],
          voices: prev?.voices ?? [],
          scriptPaths: { ...prev?.scriptPaths, ...scriptPaths },
        }));
      }

      // Fast bulk audio check — single invoke for all paths
      const audioPaths = book.chapters.map((ch) => `${book.workDir}/audio/${ch.id}.wav`);
      const existing: string[] = await invoke("file_exists", { paths: audioPaths });
      if (cancelled) return;
      const existingSet = new Set(existing);
      const paths: Record<string, string> = {};
      for (let i = 0; i < book.chapters.length; i++) {
        if (existingSet.has(audioPaths[i])) {
          paths[book.chapters[i].id] = audioPaths[i];
        }
      }
      pipeline.setChapterAudioPaths(paths);
      // Auto-select chapters that need analysis (no script yet)
      const unanalyzed = book.chapters.filter((c) => !scriptPaths[c.id]).map((c) => c.id);
      if (unanalyzed.length > 0) {
        pipeline.setSelectedChapters(new Set(unanalyzed));
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, [book.bookId, book.workDir, book.chapters]);

  function toggleChapter(chapterId: string) {
    pipeline.setSelectedChapters((prev) => {
      const next = new Set(prev);
      next.has(chapterId) ? next.delete(chapterId) : next.add(chapterId);
      return next;
    });
  }

  const allSelected = useMemo(
    () =>
      book.chapters.length > 0 &&
      book.chapters.every((c) => pipeline.selectedChapters.has(c.id)),
    [book.chapters, pipeline.selectedChapters],
  );

  function toggleAllChapters() {
    pipeline.setSelectedChapters(
      allSelected
        ? new Set()
        : new Set(book.chapters.map((c) => c.id)),
    );
  }

  function handleStop() {
    abortRef.current?.abort();
    pipeline.setAnalyzeProgress("Stopping...");
  }

  const handleGenderChange = useCallback(
    (characterId: string, gender: string) => {
      correctionState.setGender(characterId, gender);
      pipeline.setSavedMessage(null);
    },
    [correctionState.setGender, pipeline.setSavedMessage],
  );

  const handleVoiceChange = useCallback(
    (characterId: string, voiceId: string) => {
      correctionState.setVoice(characterId, voiceId);
      pipeline.setAnalysis((current) => {
        if (!current) return current;
        return {
          ...current,
          characters: current.characters.map((c) =>
            c.id === characterId ? { ...c, voiceId } : c,
          ),
        };
      });
      pipeline.setSavedMessage(null);
    },
    [
      correctionState.setVoice,
      pipeline.setAnalysis,
      pipeline.setSavedMessage,
    ],
  );

  async function handleSaveCorrections() {
    if (!book || !pipeline.analysis) return;
    pipeline.setStage("saving");
    pipeline.setError(null);
    pipeline.setSavedMessage(null);
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
      if (result.status !== "succeeded")
        throw new Error(
          (result.error as any)?.message ?? "apply_corrections failed",
        );
      const artifacts = result.artifacts as unknown as Array<{
        path: string;
        metadata: { chapterId: string };
      }>;
      const newScriptPaths = {
        ...pipeline.analysis.scriptPaths,
      };
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
          const updatedIds = new Set(
            firstScript.characters.map((c) => c.id),
          );
          pipeline.setAnalysis({
            ...pipeline.analysis,
            scriptPaths: newScriptPaths,
            characters: [
              ...pipeline.analysis.characters.filter(
                (c) => !updatedIds.has(c.id),
              ),
              ...firstScript.characters,
            ],
          });
        } else {
          pipeline.setAnalysis({
            ...pipeline.analysis,
            scriptPaths: newScriptPaths,
          });
        }
      }
      correctionState.markSaved(affectedIds);
      pipeline.setSavedMessage(
        `${affectedIds.length} chapter(s) updated.`,
      );
      pipeline.setStage("idle");
    } catch (err) {
      pipeline.setError(String(err));
      pipeline.setStage("error");
    }
  }

  async function handlePreviewVoice(voiceId: string) {
    if (!book) return;
    try {
      pipeline.setSavedMessage(
        `Generating ${voiceId} preview...`,
      );
      const previewDir = `${book.workDir}/voice-previews`;
      const scriptPath = `${previewDir}/${voiceId}.json`;
      await workerCall("_write_file", {
        path: scriptPath,
        content: JSON.stringify({
          bookId: book.bookId,
          chapterId: "voice_preview",
          segments: [
            {
              id: `preview_${voiceId}`,
              text: "This is a voice preview.",
              voiceId,
              emotion: "neutral",
              intensity: 0.2,
              pace: "normal",
            },
          ],
        }),
      });
      const result = await workerCall("synthesize_segment_audio", {
        scriptPath,
        segmentId: `preview_${voiceId}`,
        outputDirectory: previewDir,
        backend: "kokoro",
      });
      if (result.status !== "succeeded")
        throw new Error(
          (result.error as any)?.message ?? "voice preview failed",
        );
      await new Audio(
        convertFileSrc(
          (result.artifacts as Array<{ path: string }>)[0].path,
        ),
      ).play();
      pipeline.setSavedMessage(`Playing ${voiceId} preview.`);
    } catch (err) {
      pipeline.setError(String(err));
      pipeline.setStage("error");
    }
  }

  function chapterStatusIcon(chapter: ChapterMeta): string {
    if (pipeline.chapterAudioPaths[chapter.id]) return "✅";
    if (pipeline.analysis?.scriptPaths[chapter.id]) return "✓";
    return "—";
  }

  return (
    <main className="book-detail">
      <header className="detail-header">
        <button className="btn-back" onClick={onBack}>
          ← Library
        </button>
        <h1>{book.title}</h1>
        <button className="btn-secondary" onClick={handleRegenerateAll}>
          Regen All
        </button>
      </header>

      <div className="detail-body">
        <aside className="chapter-list">
          <h3>Chapters</h3>
          <label className="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAllChapters}
            />
            Select All
          </label>
          {book.chapters.map((ch) => (
            <label key={ch.id} className="chapter-item">
              <input
                type="checkbox"
                checked={pipeline.selectedChapters.has(ch.id)}
                onChange={() => toggleChapter(ch.id)}
              />
              <span className="chapter-status">
                {chapterStatusIcon(ch)}
              </span>
              <span className="chapter-title">{ch.title}</span>
            </label>
          ))}
          <button
            className="btn-primary"
            onClick={() => {
              if (pipeline.tab === "analyze") handleAnalyze();
              else if (pipeline.tab === "review")
                handleSaveCorrections();
              else handleGenerate();
            }}
            disabled={isBusy}
          >
            {pipeline.tab === "analyze"
              ? "Analyze Selected"
              : pipeline.tab === "review"
                ? "Save Corrections"
                : "Generate Selected"}
          </button>
        </aside>

        <section className="detail-content">
          <nav className="detail-tabs">
            <button
              className={`tab-btn ${pipeline.tab === "analyze" ? "active" : ""}`}
              onClick={() => pipeline.setTab("analyze")}
            >
              Analyze
            </button>
            <button
              className={`tab-btn ${pipeline.tab === "review" ? "active" : ""}`}
              onClick={() => pipeline.setTab("review")}
            >
              Review
            </button>
            <button
              className={`tab-btn ${pipeline.tab === "generate" ? "active" : ""}`}
              onClick={() => pipeline.setTab("generate")}
            >
              Generate
            </button>
          </nav>

          {pipeline.tab === "analyze" && (
            <div className="tab-panel">
              {isBusy && (
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${pipeline.progress}%` }}
                  />
                </div>
              )}
              <p>{pipeline.analyzeProgress}</p>
              {Object.entries(pipeline.chapterStatuses).map(
                ([id, status]) => (
                  <div key={id} className="chapter-status-row">
                    {id}: {status}
                  </div>
                ),
              )}
              {isBusy && (
                <button className="btn-secondary" onClick={handleStop}>
                  Stop
                </button>
              )}
            </div>
          )}

          {pipeline.tab === "review" && pipeline.analysis && (
            <div className="tab-panel">
              <table className="character-table">
                <thead>
                  <tr>
                    <th>Character</th>
                    <th>Gender</th>
                    <th>Voice</th>
                    <th>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {pipeline.analysis.characters.map((c) => (
                    <tr key={c.id}>
                      <td>{c.canonicalName}</td>
                      <td>
                        <select
                          value={c.gender}
                          onChange={(e) =>
                            handleGenderChange(c.id, e.target.value)
                          }
                        >
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                          <option value="neutral">Neutral</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={c.voiceId}
                          onChange={(e) =>
                            handleVoiceChange(c.id, e.target.value)
                          }
                        >
                          {VOICE_OPTIONS.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.displayName}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          onClick={() => handlePreviewVoice(c.voiceId)}
                        >
                          ▶
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                className="btn-primary"
                onClick={handleSaveCorrections}
                disabled={!correctionState.dirty}
              >
                Save Corrections
              </button>
              {pipeline.savedMessage && (
                <p className="success-text">
                  {pipeline.savedMessage}
                </p>
              )}
            </div>
          )}

          {pipeline.tab === "generate" && (
            <div className="tab-panel">
              {isBusy && (
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${pipeline.progress}%` }}
                  />
                </div>
              )}
              <p>{pipeline.analyzeProgress}</p>
              {pipeline.progressDetail.map((d) => (
                <div key={d.label} className="progress-detail-row">
                  {d.label}: {d.value}
                </div>
              ))}
              {isBusy && (
                <button className="btn-secondary" onClick={handleStop}>
                  Stop
                </button>
              )}
              {book.chapters
                .filter(
                  (ch) => pipeline.chapterAudioPaths[ch.id],
                )
                .map((ch) => (
                  <div key={ch.id} className="audio-row">
                    <span>{ch.title}</span>
                    <audio
                      controls
                      src={convertFileSrc(
                        pipeline.chapterAudioPaths[ch.id],
                      )}
                    />
                    <button
                      className="btn-secondary"
                      onClick={() => handleRegenerateChapter(ch)}
                    >
                      Regen
                    </button>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>

      {pipeline.error && (
        <div className="error-banner">
          {pipeline.error}
          <button
            onClick={() => {
              pipeline.setError(null);
              pipeline.setStage("idle");
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <footer
        className="character-strip"
        onClick={() => pipeline.setTab("review")}
      >
        Characters:{" "}
        {pipeline.analysis
          ? `${pipeline.analysis.characters.length} detected`
          : "None analyzed yet"}
        {pipeline.analysis &&
          pipeline.analysis.characters.slice(0, 5).map((c) => (
            <span key={c.id} className="character-chip">
              {c.canonicalName}
            </span>
          ))}
        {pipeline.analysis &&
          pipeline.analysis.characters.length > 5 && (
            <span>
              +{pipeline.analysis.characters.length - 5} more
            </span>
          )}
      </footer>
    </main>
  );
}
