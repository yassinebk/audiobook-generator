import { useEffect, useState } from "react";
import type { LibraryBook } from "../types";
import { createAudiobookStore } from "../state/store";

const db = createAudiobookStore();

interface LibraryViewProps {
  onImport: () => void;
  onSelectBook: (book: LibraryBook) => void;
  importError: string | null;
}

function chapterProgressText(book: LibraryBook, chapters: Map<string, { total: number; generated: number }>): string {
  const info = chapters.get(book.id);
  if (!info) return "—";
  if (info.generated === 0) return `${info.total} chapters`;
  return `${info.generated} / ${info.total} generated`;
}

function progressPercent(book: LibraryBook, chapters: Map<string, { total: number; generated: number }>): number {
  const info = chapters.get(book.id);
  if (!info || info.total === 0) return 0;
  return Math.round((info.generated / info.total) * 100);
}

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function LibraryView({ onImport, onSelectBook, importError }: LibraryViewProps) {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [chapterInfo, setChapterInfo] = useState<Map<string, { total: number; generated: number }>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const list = await db.listBooks();
      if (cancelled) return;
      setBooks(list);

      const chapterResults = await Promise.all(list.map((b) => db.getChapters(b.id)));
      if (cancelled) return;
      const info = new Map<string, { total: number; generated: number }>();
      for (let i = 0; i < list.length; i++) {
        const chapters = chapterResults[i];
        const generated = chapters.filter((c) => c.status === "succeeded").length;
        info.set(list[i].id, { total: chapters.length, generated });
      }
      setChapterInfo(info);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (books.length === 0) {
    return (
      <main className="library-view">
        <header className="library-topbar">
          <span className="library-wordmark">Audiobook Studio</span>
        </header>
        <div className="library-empty">
          <div className="empty-icon">📚</div>
          <h2>No books yet</h2>
          <p>Import your first EPUB to get started.</p>
          <button className="btn-primary library-import-btn" onClick={onImport}>
            + Import Book
          </button>
          {importError && <p className="error-text">{importError}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="library-view">
      <header className="library-topbar">
        <span className="library-wordmark">Audiobook Studio</span>
        <button className="btn-primary" style={{ width: "auto", padding: "8px 16px", fontSize: "12px" }} onClick={onImport}>
          + Import
        </button>
      </header>

      {importError && <p className="error-text" style={{ margin: "12px 28px 0" }}>{importError}</p>}

      <div className="library-header">
        <h1>Library</h1>
        <span className="chapter-count-badge">{books.length} book{books.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="library-grid">
        {books.map((book) => {
          const pct = progressPercent(book, chapterInfo);
          return (
            <button
              key={book.id}
              className="library-card"
              onClick={() => onSelectBook(book)}
            >
              <div className="card-cover-area">📖</div>
              <div className="card-body">
                <div className="card-title">{book.title}</div>
                <div className="card-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="progress-text">
                    {chapterProgressText(book, chapterInfo)}
                  </span>
                </div>
                <div className="card-date">{formatDate(book.importedAt)}</div>
              </div>
            </button>
          );
        })}
      </div>
    </main>
  );
}
