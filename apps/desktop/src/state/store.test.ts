// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createAudiobookStore } from "./store";

describe("audiobook state store", () => {
  test("creates book, chapter, job, character, voice, and artifact records", () => {
    const store = createAudiobookStore(":memory:");

    store.createBook({
      id: "book_123",
      title: "Tiny Book",
      sourcePath: "/tmp/tiny.epub",
      sourceLanguage: "en",
      outputLanguage: "en"
    });
    store.createChapter({
      id: "chapter_001",
      bookId: "book_123",
      title: "Chapter 1",
      status: "pending"
    });
    store.createCharacter({
      id: "elizabeth",
      bookId: "book_123",
      canonicalName: "Elizabeth",
      gender: "female",
      voiceId: "female_adult_01",
      confidence: 0.91
    });
    store.createVoice({
      id: "female_adult_01",
      displayName: "Female Adult 01",
      backend: "mock",
      language: "en"
    });
    store.createJob({
      id: "job_123",
      bookId: "book_123",
      stage: "analyze",
      status: "running"
    });
    store.createArtifact({
      id: "artifact_123",
      bookId: "book_123",
      chapterId: "chapter_001",
      kind: "script",
      path: "/tmp/book/scripts/chapter_001.json"
    });

    expect(store.getBook("book_123")?.title).toBe("Tiny Book");
    expect(store.listChapters("book_123")).toHaveLength(1);
    expect(store.listCharacters("book_123")[0].canonicalName).toBe("Elizabeth");
    expect(store.listVoices()[0].displayName).toBe("Female Adult 01");
    expect(store.listJobs("book_123")[0].status).toBe("running");
    expect(store.listArtifacts("book_123")[0].kind).toBe("script");
  });
});
