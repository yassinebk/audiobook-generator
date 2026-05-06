import { useState, useSyncExternalStore, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";
import { CharacterTable } from "./components/CharacterTable";
import { createCorrectionsStore } from "./state/corrections";
import { createAudiobookStore } from "./state/store";

const correctionsStore = createCorrectionsStore();
const db = createAudiobookStore("./audiobook.db");

interface ChapterMeta {
  id: string; title: string; textLength: number; textPath: string;
}
interface CharacterMeta {
  id: string; canonicalName: string; aliases: string[]; gender: string; voiceId: string; confidence: number;
}
interface VoiceMeta {
  id: string; displayName: string; backend: string;
}
interface BookState {
  title: string; bookId: string; workDir: string; chapters: ChapterMeta[];
}
interface AnalysisState {
  characters: CharacterMeta[]; voices: VoiceMeta[]; scriptPaths: Record<string, string>;
}
interface RightsResult {
  classification: string; reason: string; requiresAttestation: boolean; evidence: string[];
}
type PipelineStage = "idle" | "importing" | "analyzing" | "saving" | "generating" | "done" | "error";

const VOICE_DISPLAY_NAMES: Record<string, string> = {
  narrator_default: "Default Narrator", female_adult_01: "Female Adult 01", male_adult_01: "Male Adult 01", neutral_dialogue_01: "Neutral Dialogue 01",
};
const VOICE_OPTIONS = Object.entries(VOICE_DISPLAY_NAMES).map(([id, displayName]) => ({ id, displayName }));

async function workerCall(command: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await invoke<string>("run_worker", { command, inputJson: JSON.stringify(input) });
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

  const correctionState = useSyncExternalStore(correctionsStore.subscribe, correctionsStore.get);

  function toggleChapter(chapterId: string) {
    setSelectedChapters(prev => { const next = new Set(prev); if (next.has(chapterId)) next.delete(chapterId); else next.add(chapterId); return next; });
  }
  function toggleAllChapters() {
    if (!book) return;
    setSelectedChapters(prev => { if (book.chapters.every(c => prev.has(c.id))) return new Set(); return new Set(book.chapters.map(c => c.id)); });
  }
  const allChaptersSelected = book ? book.chapters.every(c => selectedChapters.has(c.id)) : false;

  function handleStop() { abortRef.current?.abort(); setAnalyzeProgress("Stopping..."); }

  async function handleImportBook() {
    const path = await open({ multiple: false, filters: [{ name: "Book", extensions: ["epub", "pdf"] }] });
    if (!path) return;
    abortRef.current?.abort();
    setStage("importing"); setError(null); setAnalysis(null); setAudioPath(null); setRights(null); setRightsAttested(false); correctionsStore.reset(); setAnalyzeProgress(""); setChapterStatuses({}); setProgressDetail([]);

    try {
      const tmp = await tempDir();
      const bookStem = (path as string).split("/").pop()?.replace(/\.[^.]+$/, "") ?? "book";
      const workDir = `${tmp}/audiobook-generator/${bookStem}`;

      const result = await workerCall("extract_book", { bookPath: path, outputDirectory: `${workDir}/chapters` });
      if (result.status !== "succeeded") throw new Error(((result.error as any)?.message) ?? "extract_book failed");

      const meta = ((result.artifacts as any[])[0]).metadata;
      const extracted: BookState = { title: meta.title, bookId: bookStem, workDir, chapters: meta.chapters };

      // Save book to DB
      db.createBook({ id: bookStem, title: meta.title, sourcePath: path as string, sourceLanguage: "en", outputLanguage: "en" } as any);

      // Check DB for already-analyzed chapters
      const existingScripts = db.getChaptersWithScripts(bookStem);
      const scriptPaths: Record<string, string> = {};
      const preAnalyzed = new Set<string>();
      for (const ch of existingScripts) {
        if (ch.scriptPath) {
          scriptPaths[ch.id] = ch.scriptPath;
          preAnalyzed.add(ch.id);
        }
      }

      setBook(extracted);
      setSelectedChapters(new Set(extracted.chapters.filter(c => !preAnalyzed.has(c.id)).map(c => c.id)));
      setProgress(preAnalyzed.size > 0 ? 30 : 10);

      if (preAnalyzed.size > 0) {
        // Restore analysis state from DB
        const allVoices: VoiceMeta[] = [];
        const allCharacters: CharacterMeta[] = [];
        const seenIds = new Set<string>();
        for (const [chId, sp] of Object.entries(scriptPaths)) {
          try {
            const raw = await invoke<string>("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: sp }) }).catch(() => "{}");
            const data = JSON.parse(raw) as { characters?: CharacterMeta[]; voices?: VoiceMeta[] } | null;
            if (data?.voices) for (const v of data.voices) { allVoices.push(v); }
            if (data?.characters) for (const c of data.characters) { if (!seenIds.has(c.id)) { seenIds.add(c.id); allCharacters.push(c); } }
          } catch {}
        }
        setAnalysis({ characters: allCharacters, voices: allVoices, scriptPaths });
        setAnalyzeProgress(`Restored ${preAnalyzed.size} previously analyzed chapter(s).`);
      }

      // Check rights
      try {
        const rr = await workerCall("check_rights", { bookPath: path, metadata: {} });
        if (rr.status === "succeeded") setRights({ classification: rr.classification as string, reason: rr.reason as string, requiresAttestation: rr.requiresAttestation as boolean, evidence: rr.evidence as string[] });
      } catch { setRights({ classification: "unknown", reason: "check_failed", requiresAttestation: true, evidence: [] }); }

      setStage("idle");
    } catch (err) { setError(String(err)); setStage("error"); }
  }

  async function handleAnalyze() {
    if (!book) return;
    const controller = new AbortController(); abortRef.current = controller;
    setStage("analyzing"); setError(null); setSavedMessage(null);
    setAnalyzeProgress("Starting analysis..."); setChapterStatuses({});
    setProgressDetail([{ label: "Model", value: "DeepSeek Flash" }, { label: "Chapters", value: String(book.chapters.length) }]);
    const startTime = Date.now();
    const modelLabel = "DeepSeek Flash";

    try {
      const scriptDir = `${book.workDir}/scripts`;
      const scripts: Record<string, string> = { ...(analysis?.scriptPaths ?? {}) };
      const allCharacters: CharacterMeta[] = [...(analysis?.characters ?? [])];
      const allVoices: VoiceMeta[] = [...(analysis?.voices ?? [])];
      const seenIds = new Set(allCharacters.map(c => c.id));
      const seenVoiceIds = new Set(allVoices.map(v => v.id));
      const statuses: Record<string, string> = {};

      const chaptersToAnalyze = book.chapters.filter(c => selectedChapters.has(c.id) && !scripts[c.id]);

      for (let i = 0; i < chaptersToAnalyze.length; i++) {
        if (controller.signal.aborted) break;
        const chapter = chaptersToAnalyze[i];
        setProgress(10 + Math.round((i / Math.max(chaptersToAnalyze.length, 1)) * 25));
        setAnalyzeProgress(`Analyzing chapter ${i + 1} of ${chaptersToAnalyze.length} using ${modelLabel}...`);
        setProgressDetail([{ label: "Model", value: modelLabel }, { label: "Progress", value: `Chapter ${i + 1} of ${chaptersToAnalyze.length}` }, { label: "Current", value: chapter.title.length > 30 ? chapter.title.slice(0, 30) + "..." : chapter.title }, { label: "Elapsed", value: `${Math.round((Date.now() - startTime) / 1000)}s` }]);
        statuses[chapter.id] = "analyzing"; setChapterStatuses({ ...statuses });

        try {
          const result = await workerCall("analyze_chapter", { bookId: book.bookId, chapterId: chapter.id, title: chapter.title, chapterTextPath: chapter.textPath, outputDirectory: scriptDir, language: "en" });
          if (result.status !== "succeeded") { statuses[chapter.id] = "failed"; continue; }

          const artifact = (result.artifacts as any[])[0];
          scripts[chapter.id] = artifact.path;
          statuses[chapter.id] = "done";

          // Save to DB
          db.upsertChapter({ id: chapter.id, bookId: book.bookId, title: chapter.title, status: "succeeded", scriptPath: artifact.path });

          const scriptRaw = await invoke<string>("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: artifact.path }) }).catch(() => "{}");
          const scriptData = JSON.parse(scriptRaw) as { characters?: CharacterMeta[]; voices?: VoiceMeta[] } | null;
          if (scriptData?.voices) for (const v of scriptData.voices) { if (!seenVoiceIds.has(v.id)) { seenVoiceIds.add(v.id); allVoices.push(v); } }
          if (scriptData?.characters) for (const c of scriptData.characters) { if (!seenIds.has(c.id)) { seenIds.add(c.id); allCharacters.push(c); } }
        } catch { statuses[chapter.id] = "failed"; }
        setChapterStatuses({ ...statuses });
      }

      const doneCount = Object.values(statuses).filter(s => s === "done").length + (analysis?.characters.length ?? 0);
      const wasStopped = controller.signal.aborted;
      setAnalysis({ characters: allCharacters, voices: allVoices, scriptPaths: scripts });
      setAnalyzeProgress(wasStopped ? `Stopped after ${doneCount} of ${book.chapters.length} chapters.` : `Analysis complete: ${Object.keys(scripts).length} of ${book.chapters.length} chapters analyzed.`);
      setProgress(wasStopped ? 40 : 40);
      setStage("idle"); abortRef.current = null;
    } catch (err) { if (!controller.signal.aborted) { setError(String(err)); setStage("error"); } else { setAnalyzeProgress("Analysis stopped."); setStage("idle"); abortRef.current = null; } }
  }

  async function handleSaveCorrections() {
    if (!book || !analysis) return; setStage("saving"); setError(null); setSavedMessage(null);
    try {
      const chaptersInput = book.chapters.map(c => ({ chapterId: c.id, textPath: c.textPath, title: c.title }));
      const result = await workerCall("apply_corrections", { bookId: book.bookId, chapters: chaptersInput, corrections: { aliasMerges: correctionState.aliasMerges, genderOverrides: correctionState.genderOverrides, voiceOverrides: correctionState.voiceOverrides }, outputDirectory: `${book.workDir}/scripts`, language: "en" });
      if (result.status !== "succeeded") throw new Error(((result.error as any)?.message) ?? "apply_corrections failed");
      const artifacts = result.artifacts as any[];
      const newScriptPaths = { ...analysis.scriptPaths }; const affectedIds: string[] = [];
      for (const art of artifacts) { newScriptPaths[art.metadata.chapterId] = art.path; affectedIds.push(art.metadata.chapterId); }
      if (artifacts.length > 0) {
        const firstScriptRaw = await invoke<string>("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: artifacts[0].path }) }).catch(() => "{}");
        const firstScript = JSON.parse(firstScriptRaw) as { characters?: CharacterMeta[]; voices?: VoiceMeta[] } | null;
        if (firstScript?.characters) { const updatedIds = new Set(firstScript.characters.map(c => c.id)); const preserved = analysis.characters.filter(c => !updatedIds.has(c.id)); setAnalysis({ ...analysis, scriptPaths: newScriptPaths, characters: [...preserved, ...firstScript.characters] }); }
        else setAnalysis({ ...analysis, scriptPaths: newScriptPaths });
      }
      correctionsStore.markSaved(affectedIds); setSavedMessage(`Corrections saved. ${affectedIds.length} chapter(s) updated.`); setStage("idle");
    } catch (err) { setError(String(err)); setStage("error"); }
  }

  async function handleGenerate() {
    if (!book || !analysis) return;
    const controller = new AbortController(); abortRef.current = controller;
    setStage("generating"); setError(null); setAnalyzeProgress("");
    setProgressDetail([{ label: "Backend", value: "Parler TTS (MPS)" }]);
    const chaptersToGenerate = book.chapters.filter(c => selectedChapters.has(c.id) && analysis.scriptPaths[c.id]);
    const startTime = Date.now();

    try {
      let generatedPath: string | null = null;
      for (let ci = 0; ci < chaptersToGenerate.length; ci++) {
        if (controller.signal.aborted) break;
        const chapter = chaptersToGenerate[ci]; const scriptPath = analysis.scriptPaths[chapter.id];
        if (!scriptPath) continue;
        const segDir = `${book.workDir}/segments/${chapter.id}`; const assembledPath = `${book.workDir}/audio/${chapter.id}.wav`;
        setAnalyzeProgress(`Synthesizing chapter ${ci + 1} of ${chaptersToGenerate.length}...`);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        flushSync(() => { setProgress(40 + Math.round((ci / chaptersToGenerate.length) * 50)); setProgressDetail([{ label: "Backend", value: "Parler TTS (MPS)" }, { label: "Chapter", value: `${ci + 1} of ${chaptersToGenerate.length}` }, { label: "Elapsed", value: `${elapsed}s` }]); });
        try { await workerCall("synthesize_chapter_audio", { scriptPath, outputDirectory: segDir, backend: "parler" }); } catch {}
        const result = await workerCall("assemble_chapter_audio", { segmentAudioDirectory: segDir, outputPath: assembledPath });
        if (result.status === "succeeded") generatedPath = assembledPath;
      }
      if (generatedPath) setAudioPath(generatedPath);
      const wasStopped = controller.signal.aborted;
      setProgress(wasStopped ? Math.round(progress) : 100);
      setAnalyzeProgress(wasStopped ? "Generation stopped. Partial audio available." : "Audio generation complete.");
      setStage(wasStopped && generatedPath ? "done" : wasStopped ? "idle" : "done"); abortRef.current = null;
    } catch (err) { if (!controller.signal.aborted) { setError(String(err)); setStage("error"); } else { setAnalyzeProgress("Generation stopped."); setStage("idle"); abortRef.current = null; } }
  }

  const handleGenderChange = useCallback((id: string, g: string) => { correctionsStore.setGender(id, g); setSavedMessage(null); }, []);
  const handleVoiceChange = useCallback((id: string, v: string) => { correctionsStore.setVoice(id, v); setSavedMessage(null); }, []);
  const isBusy = stage !== "idle" && stage !== "done" && stage !== "error";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h1>Audiobook Generator</h1>
        <button className="primary-action" onClick={handleImportBook} disabled={isBusy}>{stage === "importing" ? "Importing..." : "Import Book"}</button>
        {isBusy && <button className="stop-action" onClick={handleStop} style={{ marginTop: 8 }}>Stop</button>}
        {book && rights?.classification !== "blocked" && (
          <button className="primary-action" onClick={handleAnalyze} disabled={stage === "analyzing" || (rights?.requiresAttestation && !rightsAttested)} style={{ marginTop: 8 }}>
            {stage === "analyzing" ? "Analyzing..." : rights?.requiresAttestation && !rightsAttested ? "Attest rights first" : `Analyze${analysis ? "" : " Book"}${allChaptersSelected ? "" : ` (${selectedChapters.size})`}`}
          </button>
        )}
        {book && analysis && Object.keys(analysis.scriptPaths).length > 0 && (
          <button className="primary-action" onClick={handleGenerate} disabled={stage === "generating"} style={{ marginTop: 8 }}>{stage === "generating" ? "Generating..." : `Generate (${selectedChapters.size})`}</button>
        )}
        {analysis && (
          <button className="primary-action" onClick={handleSaveCorrections} disabled={!correctionState.dirty || stage === "saving"} style={{ marginTop: 8 }}>{stage === "saving" ? "Saving..." : "Save Corrections"}</button>
        )}
      </aside>

      <section className="workspace">
        <header className="workspace-header"><div><p className="eyebrow">Local desktop pipeline</p><h2>Job Progress</h2></div><span className="status-pill">{book?.title ?? "No active book"}</span></header>

        <section className="progress-panel">
          {stage === "error" ? <div><strong>Error</strong><p>{error}</p><button className="secondary-action" onClick={() => setStage("idle")} style={{ marginTop: 8, width: "auto", padding: "6px 14px" }}>Dismiss</button></div>
          : stage === "done" ? <div><strong>Done!</strong><p>{analyzeProgress || "Chapter audio generated."}</p>{audioPath && <p><code className="export-path">{audioPath}</code></p>}</div>
          : book ? <div><strong>{book.title}</strong><p>{book.chapters.length} chapter{book.chapters.length !== 1 ? "s" : ""}{analysis ? ` · ${analysis.characters.length} character${analysis.characters.length !== 1 ? "s" : ""} · ${Object.keys(analysis.scriptPaths).length} analyzed` : ""}</p>{analyzeProgress && <p className="analyze-progress">{analyzeProgress}</p>}{progressDetail.length > 0 && stage !== "idle" && <div className="progress-detail">{progressDetail.map(d => <span key={d.label} className="progress-detail-item"><strong>{d.label}</strong> {d.value}</span>)}</div>}</div>
          : <div><strong>Import a PDF or EPUB to begin.</strong><p>Extraction, chapter detection, dialogue analysis, and local TTS run as resumable stages.</p></div>}
          <progress value={progress} max="100" />
        </section>

        <section className="grid">
          <article><h3>Characters</h3>{analysis && analysis.characters.length > 0 ? <ul>{analysis.characters.map(c => <li key={c.id}>{c.canonicalName} <small>({c.gender} · {c.voiceId})</small></li>)}</ul> : <p>Detected speakers, gender confidence, aliases, and assigned voices will appear here.</p>}</article>

          <article><h3>Chapters</h3>
            {book ? <>
              <label className="select-all" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8125rem", marginBottom: 8, color: "#435160" }}>
                <input type="checkbox" checked={allChaptersSelected} onChange={toggleAllChapters} disabled={isBusy} />{allChaptersSelected ? "Deselect all" : "Select all"} · {selectedChapters.size}/{book.chapters.length}</label>
              <ul className="chapter-list">{book.chapters.slice(0, 15).map(c => <li key={c.id} className={!analysis?.scriptPaths[c.id] && chapterStatuses[c.id] === "failed" ? "chapter-failed" : ""}><label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}><input type="checkbox" checked={selectedChapters.has(c.id)} onChange={() => toggleChapter(c.id)} disabled={isBusy} /><span>{c.title}{analysis?.scriptPaths[c.id] ? " ✓" : chapterStatuses[c.id] === "analyzing" ? " ⏳" : chapterStatuses[c.id] === "failed" ? " ✗" : ""}{correctionState.affectedChapters.includes(c.id) ? " (pending regeneration)" : ""} <small>({Math.round(c.textLength / 1000)}k chars)</small></span></label></li>)}{book.chapters.length > 15 && <li>...and {book.chapters.length - 15} more</li>}</ul>
            </> : <p>Chapter scripts and generation state will be listed as the worker pipeline runs.</p>}
          </article>

          <article><h3>Rights</h3>
            {rights ? <><p className={`rights-badge rights-${rights.classification}`}>{rights.classification.toUpperCase()}{rights.classification === "blocked" && " — Cannot proceed"}</p><p className="rights-reason">{rights.reason.replace(/_/g, " ")}</p>{rights.requiresAttestation && <label className="attestation"><input type="checkbox" checked={rightsAttested} onChange={e => setRightsAttested(e.target.checked)} /><span>I have the right to convert this book</span></label>}</> : <><p>Unknown or restricted license status will require confirmation before generation.</p><label className="attestation"><input type="checkbox" disabled /><span>I have the right to convert this book</span></label></>}
          </article>

          <article className="review-panel"><h3>Review</h3>
            {savedMessage && <p className="saved-message">{savedMessage}</p>}
            {analysis ? <><CharacterTable characters={analysis.characters} voices={VOICE_OPTIONS} onGenderChange={handleGenderChange} onVoiceChange={handleVoiceChange} />{correctionState.dirty && <p className="hint">You have unsaved corrections. Click "Save Corrections" to apply them.</p>}</> : <p>Run analysis first to see the character table and make corrections.</p>}
          </article>

          <article><h3>Export</h3>
            {audioPath ? <><p>Chapter audio ready:</p><code className="export-path">{audioPath}</code><button className="primary-action" onClick={async () => { try { const p = await open({ multiple: false, defaultPath: "chapter.wav", filters: [{ name: "Audio", extensions: ["wav"] }] }); if (!p) return; await invoke("copy_file", { from: audioPath, to: p as string }); setSavedMessage(`Saved to ${p}`); } catch (err) { setError(String(err)); } }} style={{ marginTop: 12 }}>Save Audio File</button></> : <p>Completed chapter audio and metadata exports will be available after generation.</p>}
          </article>
        </section>
      </section>
    </main>
  );
}
