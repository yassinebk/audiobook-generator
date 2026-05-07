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

    // Dedup check
    try {
      const existing = await db.getBook(sourcePath);
      if (existing) {
        setImportError(
          `"${existing.title}" is already in your library. Opening it now.`,
        );
        const cache = await cachedBookFromExtraction({
          cachePath: extractionCachePath(existing.workDir),
          sourcePath,
          readJson: async (p) =>
            await invoke("run_worker", {
              command: "_read_file",
              inputJson: JSON.stringify({ path: p }),
            }),
        });
        if (cache) {
          navigateToBook(cache);
          return;
        }
        const chapters = await db.getChapters(existing.id);
        navigateToBook({
          title: existing.title,
          bookId: existing.id,
          workDir: existing.workDir,
          chapters: chapters.map((c) => ({
            id: c.id,
            title: c.title,
            textLength: 0,
            textPath: `${existing.workDir}/chapters/${c.id}.txt`,
          })),
        });
        return;
      }
    } catch {
      // Non-critical, proceed with import
    }

    // New import flow
    setImportError(null);
    try {
      const bookStem = getBookStem(sourcePath);
      const bookId = `${bookStem}_${Date.now()}`;
      const workDir = await db.bookWorkDir(bookId);

      let extracted = await cachedBookFromExtraction({
        cachePath: extractionCachePath(workDir),
        sourcePath,
        readJson: async (p) =>
          await invoke("run_worker", {
            command: "_read_file",
            inputJson: JSON.stringify({ path: p }),
          }),
      });

      if (!extracted) {
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
          result.artifacts as Array<{
            metadata: {
              title: string;
              chapters: {
                id: string;
                title: string;
                textLength: number;
                textPath: string;
              }[];
            };
          }>
        )[0];
        extracted = {
          title: artifact.metadata.title,
          bookId,
          workDir,
          chapters: artifact.metadata.chapters,
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
      }

      await db.createBook({
        id: bookId,
        title: extracted.title,
        sourcePath,
        workDir: extracted.workDir,
      });

      navigateToBook(extracted);
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
            navigateToBook(cache);
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
          });
        }}
        importError={importError}
      />
    );
  }

  if (activeBook && view.page === "bookDetail") {
    const libBook: LibraryBook = {
      id: activeBook.bookId,
      title: activeBook.title,
      sourcePath: "",
      workDir: activeBook.workDir,
      importedAt: null,
    };
    return (
      <BookDetailView
        libraryBook={libBook}
        book={activeBook}
        onBack={navigateToLibrary}
      />
    );
  }

  return null;
}
