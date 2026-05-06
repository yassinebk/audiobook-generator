import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseLike;
};

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "needs_review";

export interface BookRecord {
  id: string;
  title: string;
  sourcePath: string;
  sourceLanguage: string;
  outputLanguage: string;
}

export interface ChapterRecord {
  id: string;
  bookId: string;
  title: string;
  status: StageStatus;
}

export interface CharacterRecord {
  id: string;
  bookId: string;
  canonicalName: string;
  gender: string;
  voiceId: string;
  confidence: number;
}

export interface VoiceRecord {
  id: string;
  displayName: string;
  backend: string;
  language: string;
}

export interface JobRecord {
  id: string;
  bookId: string;
  stage: string;
  status: StageStatus;
}

export interface ArtifactRecord {
  id: string;
  bookId: string;
  chapterId?: string;
  kind: string;
  path: string;
}

export function createAudiobookStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_language TEXT NOT NULL,
      output_language TEXT NOT NULL,
      work_dir TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT NOT NULL,
      book_id TEXT NOT NULL REFERENCES books(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      script_path TEXT,
      PRIMARY KEY (id, book_id)
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT NOT NULL,
      book_id TEXT NOT NULL REFERENCES books(id),
      canonical_name TEXT NOT NULL,
      gender TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (id, book_id)
    );

    CREATE TABLE IF NOT EXISTS voices (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      backend TEXT NOT NULL,
      language TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id),
      stage TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id),
      chapter_id TEXT REFERENCES chapters(id),
      kind TEXT NOT NULL,
      path TEXT NOT NULL
    );
  `);

  return {
    createBook(record: BookRecord) {
      db.prepare(`
        INSERT OR REPLACE INTO books (id, title, source_path, source_language, output_language, work_dir)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.id, record.title, record.sourcePath, record.sourceLanguage, record.outputLanguage, (record as any).workDir ?? "");
    },

    getBook(id: string) {
      const row = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
      return row ? mapBook(row) : undefined;
    },

    createChapter(record: ChapterRecord) {
      db.prepare(`
        INSERT INTO chapters (id, book_id, title, status)
        VALUES (?, ?, ?, ?)
      `).run(record.id, record.bookId, record.title, record.status);
    },

    listChapters(bookId: string): ChapterRecord[] {
      return (db.prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY id").all(bookId) as ChapterRow[]).map(
        mapChapter,
      );
    },

    createCharacter(record: CharacterRecord) {
      db.prepare(`
        INSERT INTO characters (id, book_id, canonical_name, gender, voice_id, confidence)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.id, record.bookId, record.canonicalName, record.gender, record.voiceId, record.confidence);
    },

    listCharacters(bookId: string): CharacterRecord[] {
      return (
        db.prepare("SELECT * FROM characters WHERE book_id = ? ORDER BY canonical_name").all(bookId) as CharacterRow[]
      ).map(mapCharacter);
    },

    createVoice(record: VoiceRecord) {
      db.prepare(`
        INSERT INTO voices (id, display_name, backend, language)
        VALUES (?, ?, ?, ?)
      `).run(record.id, record.displayName, record.backend, record.language);
    },

    listVoices(): VoiceRecord[] {
      return (db.prepare("SELECT * FROM voices ORDER BY id").all() as VoiceRow[]).map(mapVoice);
    },

    createJob(record: JobRecord) {
      db.prepare(`
        INSERT INTO jobs (id, book_id, stage, status)
        VALUES (?, ?, ?, ?)
      `).run(record.id, record.bookId, record.stage, record.status);
    },

    listJobs(bookId: string): JobRecord[] {
      return (db.prepare("SELECT * FROM jobs WHERE book_id = ? ORDER BY id").all(bookId) as JobRow[]).map(mapJob);
    },

    createArtifact(record: ArtifactRecord) {
      db.prepare(`
        INSERT INTO artifacts (id, book_id, chapter_id, kind, path)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.id, record.bookId, record.chapterId ?? null, record.kind, record.path);
    },

    listArtifacts(bookId: string): ArtifactRecord[] {
      return (db.prepare("SELECT * FROM artifacts WHERE book_id = ? ORDER BY id").all(bookId) as ArtifactRow[]).map(
        mapArtifact,
      );
    },

    upsertChapter(record: ChapterRecord & { scriptPath?: string }) {
      db.prepare(`
        INSERT OR REPLACE INTO chapters (id, book_id, title, status, script_path)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.id, record.bookId, record.title, record.status, record.scriptPath ?? null);
    },

    getChaptersWithScripts(bookId: string): Array<{ id: string; scriptPath: string }> {
      const rows = db.prepare(
        "SELECT id, script_path FROM chapters WHERE book_id = ? AND script_path IS NOT NULL"
      ).all(bookId) as Array<{ id: string; script_path: string }>;
      return rows.map(r => ({ id: r.id, scriptPath: r.script_path }));
    },

    getChapter(bookId: string, chapterId: string) {
      const row = db.prepare(
        "SELECT * FROM chapters WHERE book_id = ? AND id = ?"
      ).get(bookId, chapterId) as (ChapterRow & { script_path?: string }) | undefined;
      if (!row) return undefined;
      return { ...mapChapter(row), scriptPath: row.script_path ?? undefined };
    },

    getBookBySourcePath(sourcePath: string) {
      const row = db.prepare("SELECT * FROM books WHERE source_path = ?").get(sourcePath) as BookRow | undefined;
      return row ? mapBook(row) : undefined;
    },
  };
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
}

interface StatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BookRow {
  id: string;
  title: string;
  source_path: string;
  source_language: string;
  output_language: string;
  work_dir: string;
}

interface ChapterRow {
  id: string;
  book_id: string;
  title: string;
  status: StageStatus;
}

interface CharacterRow {
  id: string;
  book_id: string;
  canonical_name: string;
  gender: string;
  voice_id: string;
  confidence: number;
}

interface VoiceRow {
  id: string;
  display_name: string;
  backend: string;
  language: string;
}

interface JobRow {
  id: string;
  book_id: string;
  stage: string;
  status: StageStatus;
}

interface ArtifactRow {
  id: string;
  book_id: string;
  chapter_id: string | null;
  kind: string;
  path: string;
}

function mapBook(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    sourcePath: row.source_path,
    sourceLanguage: row.source_language,
    outputLanguage: row.output_language,
  };
}

function mapChapter(row: ChapterRow): ChapterRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    status: row.status,
  };
}

function mapCharacter(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    canonicalName: row.canonical_name,
    gender: row.gender,
    voiceId: row.voice_id,
    confidence: row.confidence,
  };
}

function mapVoice(row: VoiceRow): VoiceRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    backend: row.backend,
    language: row.language,
  };
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    stage: row.stage,
    status: row.status,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    chapterId: row.chapter_id ?? undefined,
    kind: row.kind,
    path: row.path,
  };
}
