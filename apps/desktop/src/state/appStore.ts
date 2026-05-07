import { create } from "zustand";
import type { AppView, BookState } from "../types";

interface AppState {
  view: AppView;
  activeBook: BookState | null;
  activeSourcePath: string;
  importError: string | null;
  navigateToLibrary: () => void;
  navigateToBook: (book: BookState, sourcePath: string) => void;
  setImportError: (err: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: { page: "library" },
  activeBook: null,
  activeSourcePath: "",
  importError: null,
  navigateToLibrary: () =>
    set({ view: { page: "library" }, importError: null }),
  navigateToBook: (book, sourcePath) =>
    set({
      activeBook: book,
      activeSourcePath: sourcePath,
      view: { page: "bookDetail", bookId: book.bookId },
    }),
  setImportError: (err) => set({ importError: err }),
}));
