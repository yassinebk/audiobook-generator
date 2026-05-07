import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: vi.fn((path: string) => path),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: vi.fn().mockResolvedValue("/tmp/test"),
}));
vi.mock("./state/store", () => ({
  createAudiobookStore: () => ({
    listBooks: vi.fn().mockResolvedValue([]),
    getBook: vi.fn().mockResolvedValue(null),
    getChapters: vi.fn().mockResolvedValue([]),
    createBook: vi.fn().mockResolvedValue(null),
    upsertChapter: vi.fn().mockResolvedValue(null),
    getChaptersWithScripts: vi.fn().mockResolvedValue([]),
    upsertCharacter: vi.fn().mockResolvedValue(null),
    getCharacters: vi.fn().mockResolvedValue([]),
  }),
}));

describe("App", () => {
  it("renders the library view", async () => {
    render(<App />);
    expect(screen.getByText("No books yet")).toBeDefined();
  });
});
