import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("@tauri-apps/api/path", () => ({
  tempDir: vi.fn().mockResolvedValue("/tmp"),
}));

describe("App — initial render (Step 1)", () => {
  test("shows step 1 workspace with Import Book heading and Choose File button", () => {
    render(<App />);
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Import Book" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Choose File/i })).toBeInTheDocument();
  });

  test("sidebar shows all pipeline step labels", () => {
    render(<App />);
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Analyze")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Generate")).toBeInTheDocument();
    expect(screen.getByText("Listen")).toBeInTheDocument();
  });

  test("step 1 is marked as current step in the sidebar", () => {
    render(<App />);
    const importButton = screen.getAllByRole("button").find(
      (btn) => btn.textContent?.includes("Import") && btn.getAttribute("aria-current") === "step"
    );
    expect(importButton).toBeTruthy();
  });

  test("steps 2–5 are disabled when no book is loaded", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Pipeline steps" });
    const stepButtons = nav.querySelectorAll("button");
    // Steps 2, 3, 4, 5 (indices 1–4) should be disabled
    expect(stepButtons[1]).toBeDisabled();
    expect(stepButtons[2]).toBeDisabled();
    expect(stepButtons[3]).toBeDisabled();
    expect(stepButtons[4]).toBeDisabled();
  });
});
