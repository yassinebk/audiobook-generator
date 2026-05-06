import { invoke } from "@tauri-apps/api/core";

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
  };
}
