// Browser-compatible state store — persists to /tmp/audiobook-generator-state.json via worker

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "needs_review";

export interface BookRecord { id: string; title: string; sourcePath: string; sourceLanguage: string; outputLanguage: string; workDir: string; }
export interface ChapterRecord { id: string; bookId: string; title: string; status: StageStatus; scriptPath?: string; }
export interface CharacterRecord { id: string; bookId: string; canonicalName: string; gender: string; voiceId: string; confidence: number; }
export interface JobRecord { id: string; bookId: string; stage: string; status: StageStatus; }
export interface ArtifactRecord { id: string; bookId: string; chapterId?: string; kind: string; path: string; }

interface AppState { books: BookRecord[]; chapters: ChapterRecord[]; }
function emptyState(): AppState { return { books: [], chapters: [] }; }

const STATE_PATH = "/tmp/audiobook-generator-state.json";

// We need invoke from @tauri-apps/api but can't import it at module level in vite
function getInvoke(): any {
  return (window as any).__TAURI_INTERNALS__?.invoke;
}

async function loadState(): Promise<AppState> {
  try {
    const invokeFn = getInvoke();
    const raw = await invokeFn("run_worker", { command: "_read_file", inputJson: JSON.stringify({ path: STATE_PATH }) });
    if (!raw || typeof raw !== "object") return emptyState();
    return { books: raw.books ?? [], chapters: raw.chapters ?? [] };
  } catch { return emptyState(); }
}

function saveState(state: AppState) {
  try {
    const invokeFn = getInvoke();
    if (!invokeFn) return;
    invokeFn("run_worker", {
      command: "_write_file",
      inputJson: JSON.stringify({ path: STATE_PATH, content: JSON.stringify(state) }),
    }).catch(() => {});
  } catch {}
}

function createMemoryStore() {
  let state: AppState = emptyState();

  return {
    async init() { state = await loadState(); },

    createBook(record: BookRecord) {
      state.books = state.books.filter(b => b.id !== record.id);
      state.books.push(record); saveState(state);
    },
    getBook(id: string) { return state.books.find(b => b.id === id); },

    upsertChapter(record: { id: string; bookId: string; title: string; status: string; scriptPath?: string }) {
      state.chapters = state.chapters.filter(c => !(c.id === record.id && c.bookId === record.bookId));
      state.chapters.push({ id: record.id, bookId: record.bookId, title: record.title, status: record.status as StageStatus, scriptPath: record.scriptPath });
      saveState(state);
    },
    getChaptersWithScripts(bookId: string) {
      return state.chapters.filter(c => c.bookId === bookId && c.scriptPath).map(c => ({ id: c.id, scriptPath: c.scriptPath! }));
    },
    getBookBySourcePath(sourcePath: string) { return state.books.find(b => b.sourcePath === sourcePath); },
  };
}

const memoryStore = createMemoryStore();
export function createAudiobookStore(_path?: string) { return memoryStore; }
