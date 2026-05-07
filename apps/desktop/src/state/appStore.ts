import { create } from "zustand";
import type { AppView, BookState } from "../types";

interface AppState {
  view: AppView;
  activeBook: BookState | null;
  importError: string | null;
  navigateToLibrary: () => void;
  navigateToBook: (book: BookState) => void;
  setImportError: (err: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: { page: "library" },
  activeBook: null,
  importError: null,
  navigateToLibrary: () =>
    set({ view: { page: "library" }, importError: null }),
  navigateToBook: (book) =>
    set({
      activeBook: book,
      view: { page: "bookDetail", bookId: book.bookId },
    }),
  setImportError: (err) => set({ importError: err }),
}));
