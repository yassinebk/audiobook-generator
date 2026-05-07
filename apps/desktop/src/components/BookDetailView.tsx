import { useRef, useState, useSyncExternalStore, useCallback, useEffect } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AnalysisState, BookState, ChapterMeta, CharacterMeta, LibraryBook, PipelineStage, ProgressDetail, VoiceMeta } from "../types";
import { createAudiobookStore } from "../state/store";
import { createCorrectionsStore } from "../state/corrections";
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

type DetailTab = "analyze" | "review" | "generate";

interface BookDetailViewProps {
  libraryBook: LibraryBook;
  book: BookState;
  onBack: () => void;
}

export function BookDetailView({ libraryBook, book, onBack }: BookDetailViewProps) {
  const [tab, setTab] = useState<DetailTab>("analyze");
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [chapterAudioPaths, setChapterAudioPaths] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [analyzeProgress, setAnalyzeProgress] = useState("");
  const [chapterStatuses, setChapterStatuses] = useState<Record<string, string>>({});
  const [progressDetail, setProgressDetail] = useState<ProgressDetail[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const correctionsStoreRef = useRef(createCorrectionsStore());
  const correctionState = useSyncExternalStore(
    correctionsStoreRef.current.subscribe,
    correctionsStoreRef.current.get,
  );

  const isBusy = stage === "importing" || stage === "analyzing" || stage === "saving" || stage === "generating";

  const noopSetCurrentStep = () => {};

  const { handleAnalyze } = useChapterAnalysis({
    book, selectedChapters, setStage, setError, setSavedMessage,
    setAnalyzeProgress, setChapterStatuses, setProgressDetail, setProgress,
    setAnalysis, setCurrentStep: noopSetCurrentStep, abortRef, db,
  });

  const { handleGenerate, handleRegenerateChapter, handleRegenerateAll } = useGeneration({
    book, analysis, selectedChapters, chapterAudioPaths,
    correctionState: correctionState as { affectedChapters: string[]; dirty?: boolean },
    setStage, setError, setAnalyzeProgress, setProgressDetail, setProgress,
    setChapterAudioPaths, setCurrentStep: noopSetCurrentStep, abortRef,
  });

  // Restore saved state on mount
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const chars = await db.getCharacters(book.bookId);
      if (cancelled) return;
      if (chars.length > 0) {
        setAnalysis(prev => ({
          characters: chars.map((c): CharacterMeta => ({
            id: c.id,
            canonicalName: c.canonicalName,
            aliases: JSON.parse(c.aliases || "[]"),
            gender: c.gender || "unknown",
            voiceId: c.voiceId || "narrator_default",
            confidence: c.confidence,
          })),
          voices: prev?.voices ?? [],
          scriptPaths: prev?.scriptPaths ?? {},
        }));
      }

      const chaptersWithScripts = await db.getChaptersWithScripts(book.bookId);
      if (cancelled) return;
      const scriptPaths: Record<string, string> = {};
      for (const ch of chaptersWithScripts) {
        scriptPaths[ch.id] = ch.scriptPath;
      }
      if (Object.keys(scriptPaths).length > 0) {
        setAnalysis(prev => prev ? { ...prev, scriptPaths: { ...prev.scriptPaths, ...scriptPaths } } : { characters: [], voices: [], scriptPaths });
      }

      const audioPaths: Record<string, string> = {};
      for (const ch of book.chapters) {
        const audioPath = `${book.workDir}/audio/${ch.id}.wav`;
        try {
          await invoke("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: audioPath }) });
          audioPaths[ch.id] = audioPath;
        } catch { /* file doesn't exist */ }
      }
      if (!cancelled) setChapterAudioPaths(audioPaths);
    }
    restore();
    return () => { cancelled = true; };
  }, [book.bookId, book.workDir, book.chapters]);

  function toggleChapter(chapterId: string) {
    setSelectedChapters(prev => {
      const next = new Set(prev);
      next.has(chapterId) ? next.delete(chapterId) : next.add(chapterId);
      return next;
    });
  }

  function toggleAllChapters() {
    const allSelected = book.chapters.length > 0 && book.chapters.every(c => selectedChapters.has(c.id));
    setSelectedChapters(allSelected ? new Set() : new Set(book.chapters.map(c => c.id)));
  }

  function handleStop() { abortRef.current?.abort(); setAnalyzeProgress("Stopping..."); }

  const handleGenderChange = useCallback((characterId: string, gender: string) => {
    correctionsStoreRef.current.setGender(characterId, gender);
    setSavedMessage(null);
  }, []);

  const handleVoiceChange = useCallback((characterId: string, voiceId: string) => {
    correctionsStoreRef.current.setVoice(characterId, voiceId);
    setAnalysis(current => {
      if (!current) return current;
      return {
        ...current,
        characters: current.characters.map(c =>
          c.id === characterId ? { ...c, voiceId } : c
        ),
      };
    });
    setSavedMessage(null);
  }, []);

  async function handleSaveCorrections() {
    if (!book || !analysis) return;
    setStage("saving");
    setError(null);
    setSavedMessage(null);
    try {
      const result = await workerCall("apply_corrections", {
        bookId: book.bookId,
        chapters: book.chapters.map(c => ({ chapterId: c.id, textPath: c.textPath, title: c.title })),
        corrections: {
          aliasMerges: correctionState.aliasMerges,
          genderOverrides: correctionState.genderOverrides,
          voiceOverrides: correctionState.voiceOverrides,
        },
        outputDirectory: `${book.workDir}/scripts`,
        language: "en",
      });
      if (result.status !== "succeeded") throw new Error((result.error as any)?.message ?? "apply_corrections failed");
      const artifacts = result.artifacts as Array<{ path: string; metadata: { chapterId: string } }>;
      const newScriptPaths = { ...analysis.scriptPaths };
      const affectedIds: string[] = [];
      for (const art of artifacts) {
        newScriptPaths[art.metadata.chapterId] = art.path;
        affectedIds.push(art.metadata.chapterId);
      }
      if (artifacts.length > 0) {
        const firstScriptRaw = await invoke<string>("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: artifacts[0].path }) }).catch(() => "{}");
        const firstScript = JSON.parse(firstScriptRaw) as { characters?: CharacterMeta[]; voices?: VoiceMeta[] } | null;
        if (firstScript?.characters) {
          const updatedIds = new Set(firstScript.characters.map(c => c.id));
          setAnalysis({ ...analysis, scriptPaths: newScriptPaths, characters: [...analysis.characters.filter(c => !updatedIds.has(c.id)), ...firstScript.characters] });
        } else {
          setAnalysis({ ...analysis, scriptPaths: newScriptPaths });
        }
      }
      correctionsStoreRef.current.markSaved(affectedIds);
      setSavedMessage(`${affectedIds.length} chapter(s) updated.`);
      setStage("idle");
    } catch (err) { setError(String(err)); setStage("error"); }
  }

  async function handlePreviewVoice(voiceId: string) {
    if (!book) return;
    try {
      setSavedMessage(`Generating ${voiceId} preview...`);
      const previewDir = `${book.workDir}/voice-previews`;
      const scriptPath = `${previewDir}/${voiceId}.json`;
      await workerCall("_write_file", { path: scriptPath, content: JSON.stringify({ bookId: book.bookId, chapterId: "voice_preview", segments: [{ id: `preview_${voiceId}`, text: "This is a voice preview.", voiceId, emotion: "neutral", intensity: 0.2, pace: "normal" }] }) });
      const result = await workerCall("synthesize_segment_audio", { scriptPath, segmentId: `preview_${voiceId}`, outputDirectory: previewDir, backend: "kokoro" });
      if (result.status !== "succeeded") throw new Error((result.error as any)?.message ?? "voice preview failed");
      await new Audio(convertFileSrc((result.artifacts as Array<{ path: string }>)[0].path)).play();
      setSavedMessage(`Playing ${voiceId} preview.`);
    } catch (err) { setError(String(err)); setStage("error"); }
  }

  function chapterStatusIcon(chapter: ChapterMeta): string {
    if (chapterAudioPaths[chapter.id]) return "✅";
    if (analysis?.scriptPaths[chapter.id]) return "✓";
    return "—";
  }

  return (
    <main className="book-detail">
      <header className="detail-header">
        <button className="btn-back" onClick={onBack}>← Library</button>
        <h1>{book.title}</h1>
        <button className="btn-secondary" onClick={handleRegenerateAll}>Regen All</button>
      </header>

      <div className="detail-body">
        <aside className="chapter-list">
          <h3>Chapters</h3>
          <label className="select-all">
            <input type="checkbox" checked={book.chapters.length > 0 && book.chapters.every(c => selectedChapters.has(c.id))} onChange={toggleAllChapters} />
            Select All
          </label>
          {book.chapters.map(ch => (
            <label key={ch.id} className="chapter-item">
              <input type="checkbox" checked={selectedChapters.has(ch.id)} onChange={() => toggleChapter(ch.id)} />
              <span className="chapter-status">{chapterStatusIcon(ch)}</span>
              <span className="chapter-title">{ch.title}</span>
            </label>
          ))}
          <button className="btn-primary" onClick={() => { if (tab === "analyze") handleAnalyze(); else handleGenerate(); }} disabled={isBusy}>
            {tab === "analyze" ? "Analyze Selected" : tab === "review" ? "Save Corrections" : "Generate Selected"}
          </button>
        </aside>

        <section className="detail-content">
          <nav className="detail-tabs">
            <button className={`tab-btn ${tab === "analyze" ? "active" : ""}`} onClick={() => setTab("analyze")}>Analyze</button>
            <button className={`tab-btn ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>Review</button>
            <button className={`tab-btn ${tab === "generate" ? "active" : ""}`} onClick={() => setTab("generate")}>Generate</button>
          </nav>

          {tab === "analyze" && (
            <div className="tab-panel">
              {isBusy && <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>}
              <p>{analyzeProgress}</p>
              {Object.entries(chapterStatuses).map(([id, status]) => (
                <div key={id} className="chapter-status-row">{id}: {status}</div>
              ))}
              {isBusy && <button className="btn-secondary" onClick={handleStop}>Stop</button>}
            </div>
          )}

          {tab === "review" && analysis && (
            <div className="tab-panel">
              <table className="character-table">
                <thead><tr><th>Character</th><th>Gender</th><th>Voice</th><th>Preview</th></tr></thead>
                <tbody>
                  {analysis.characters.map(c => (
                    <tr key={c.id}>
                      <td>{c.canonicalName}</td>
                      <td>
                        <select value={c.gender} onChange={e => handleGenderChange(c.id, e.target.value)}>
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                          <option value="neutral">Neutral</option>
                        </select>
                      </td>
                      <td>
                        <select value={c.voiceId} onChange={e => handleVoiceChange(c.id, e.target.value)}>
                          {VOICE_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.displayName}</option>)}
                        </select>
                      </td>
                      <td><button onClick={() => handlePreviewVoice(c.voiceId)}>▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn-primary" onClick={handleSaveCorrections} disabled={!correctionState.dirty}>Save Corrections</button>
              {savedMessage && <p className="success-text">{savedMessage}</p>}
            </div>
          )}

          {tab === "generate" && (
            <div className="tab-panel">
              {isBusy && <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>}
              <p>{analyzeProgress}</p>
              {progressDetail.map(d => <div key={d.label} className="progress-detail-row">{d.label}: {d.value}</div>)}
              {isBusy && <button className="btn-secondary" onClick={handleStop}>Stop</button>}
              {book.chapters.filter(ch => chapterAudioPaths[ch.id]).map(ch => (
                <div key={ch.id} className="audio-row">
                  <span>{ch.title}</span>
                  <audio controls src={convertFileSrc(chapterAudioPaths[ch.id])} />
                  <button className="btn-secondary" onClick={() => handleRegenerateChapter(ch)}>Regen</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => { setError(null); setStage("idle"); }}>Dismiss</button>
        </div>
      )}

      <footer className="character-strip" onClick={() => setTab("review")}>
        Characters: {analysis ? `${analysis.characters.length} detected` : "None analyzed yet"}
        {analysis && analysis.characters.slice(0, 5).map(c => (
          <span key={c.id} className="character-chip">{c.canonicalName}</span>
        ))}
        {analysis && analysis.characters.length > 5 && <span>+{analysis.characters.length - 5} more</span>}
      </footer>
    </main>
  );
}
