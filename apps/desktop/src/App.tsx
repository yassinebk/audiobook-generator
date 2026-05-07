import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { BookState, LibraryBook } from "./types";
import { LibraryView } from "./components/LibraryView";
import { BookDetailView } from "./components/BookDetailView";
import { createAudiobookStore } from "./state/store";
import { useAppStore } from "./state/appStore";
import { workerCall } from "./lib/workerCall";
import {
  cachedBookFromExtraction,
  extractionCachePath,
  writeExtractionCache,
} from "./lib/importCache";

const db = createAudiobookStore();

function getBookStem(path: string): string {
  return path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "book";
}

export function App() {
  const {
    view,
    activeBook,
    activeSourcePath,
    importError,
    navigateToLibrary,
    navigateToBook,
    setImportError,
  } = useAppStore();

  const handleImport = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Book", extensions: ["epub", "pdf"] }],
    });
    if (!path) return;

    const sourcePath = path as string;

    // Check if book was imported before
    let existingBook: LibraryBook | null = null;
    try {
      existingBook = await db.getBook(sourcePath);
    } catch {
      // ignore
    }

    setImportError(null);
    try {
      const bookId = existingBook?.id ?? `${getBookStem(sourcePath)}_${Date.now()}`;
      const workDir = existingBook?.workDir ?? await db.bookWorkDir(bookId);

      // Always re-extract to catch missing chapters from previous runs
      const result = await workerCall("extract_book", {
        bookPath: sourcePath,
        outputDirectory: `${workDir}/chapters`,
      });
      if (result.status !== "succeeded") {
        throw new Error(
          (result.error as any)?.message ?? "extract_book failed",
        );
      }
      const artifact = (
        result.artifacts as unknown as Array<{
          metadata: {
            title: string;
            chapters: { id: string; title: string; textLength: number; textPath: string }[];
          };
        }>
      )[0];
      const freshChapters = artifact.metadata.chapters;

      // Merge: preserve existing script paths for previously analyzed chapters
      const existingChapters = existingBook
        ? await db.getChaptersWithScripts(bookId)
        : [];
      const existingScripts = new Map(existingChapters.map((c) => [c.id, c.scriptPath]));

      for (const c of freshChapters) {
        db.upsertChapter({
          id: c.id,
          bookId,
          title: c.title,
          status: existingScripts.has(c.id) ? "succeeded" : "pending",
          scriptPath: existingScripts.get(c.id),
        }).catch(() => {});
      }

      const extracted: BookState = {
        title: artifact.metadata.title,
        bookId,
        workDir,
        chapters: freshChapters,
      };

      await writeExtractionCache({
        sourcePath,
        book: extracted,
        writeJson: async (p, payload) => {
          await workerCall("_write_file", {
            path: p,
            content: JSON.stringify(payload),
          });
        },
      });

      await db.createBook({
        id: bookId,
        title: extracted.title,
        sourcePath,
        workDir: extracted.workDir,
      });

      if (existingBook) {
        setImportError(`Re-extracted "${extracted.title}". Found ${freshChapters.length} chapters${existingChapters.length > 0 ? ` (${existingChapters.length} already analyzed).` : "."}`);
      }
      navigateToBook(extracted, sourcePath);
    } catch (err) {
      setImportError(String(err));
    }
  }, [navigateToBook, setImportError]);

  if (view.page === "library") {
    return (
      <LibraryView
        onImport={handleImport}
        onSelectBook={async (libBook: LibraryBook) => {
          const cache = await cachedBookFromExtraction({
            cachePath: extractionCachePath(libBook.workDir),
            sourcePath: libBook.sourcePath,
            readJson: async (p) =>
              await invoke("run_worker", {
                command: "_read_file",
                inputJson: JSON.stringify({ path: p }),
              }),
          });
          if (cache) {
            navigateToBook(cache, libBook.sourcePath);
            return;
          }
          const chapters = await db.getChapters(libBook.id);
          navigateToBook({
            title: libBook.title,
            bookId: libBook.id,
            workDir: libBook.workDir,
            chapters: chapters.map((c) => ({
              id: c.id,
              title: c.title,
              textLength: 0,
              textPath: `${libBook.workDir}/chapters/${c.id}.txt`,
            })),
          }, libBook.sourcePath);
        }}
        importError={importError}
      />
    );
  }

  if (activeBook && view.page === "bookDetail") {
    const libBook: LibraryBook = {
      id: activeBook.bookId,
      title: activeBook.title,
      sourcePath: activeSourcePath,
      workDir: activeBook.workDir,
      importedAt: null,
    };
    return (
      <BookDetailView
        libraryBook={libBook}
        book={activeBook}
        sourcePath={activeSourcePath}
        onBack={navigateToLibrary}
      />
    );
  }

  return null;
}
