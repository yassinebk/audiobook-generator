import { invoke } from "@tauri-apps/api/core";
import type { LibraryBook, CharacterRecord, ChapterRecord } from "../types";

export function createAudiobookStore() {
  return {
    createBook(record: { id: string; title: string; sourcePath: string; workDir: string }) {
      return invoke("db_create_book", { id: record.id, title: record.title, sourcePath: record.sourcePath, workDir: record.workDir });
    },
    upsertChapter(record: { id: string; bookId: string; title: string; status: string; scriptPath?: string }) {
      return invoke("db_upsert_chapter", { id: record.id, bookId: record.bookId, title: record.title, status: record.status, scriptPath: record.scriptPath ?? null });
    },
    async getChaptersWithScripts(bookId: string): Promise<Array<{ id: string; scriptPath: string }>> {
      return await invoke("db_get_chapters_with_scripts", { bookId }) as any;
    },
    async listBooks(): Promise<LibraryBook[]> {
      return await invoke("db_list_books") as any;
    },
    async getBook(sourcePath: string): Promise<LibraryBook | null> {
      return await invoke("db_get_book", { sourcePath }) as any;
    },
    async upsertCharacter(record: {
      id: string; bookId: string; canonicalName: string;
      gender?: string | null; voiceId?: string | null;
      confidence?: number; aliases?: string;
    }) {
      return invoke("db_upsert_character", {
        id: record.id, bookId: record.bookId,
        canonicalName: record.canonicalName,
        gender: record.gender ?? null,
        voiceId: record.voiceId ?? null,
        confidence: record.confidence ?? 0.0,
        aliases: record.aliases ?? "[]",
      });
    },
    async getCharacters(bookId: string): Promise<CharacterRecord[]> {
      return await invoke("db_get_characters", { bookId }) as any;
    },
    async getChapters(bookId: string): Promise<ChapterRecord[]> {
      return await invoke("db_get_chapters", { bookId }) as any;
    },
  };
}
