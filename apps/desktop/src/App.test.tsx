import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { App } from "./App";

describe("App", () => {
  test("shows the core MVP workflow screens", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Audiobook Generator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import Book" })).toBeInTheDocument();
    expect(screen.getByText("Job Progress")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Characters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chapters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rights" })).toBeInTheDocument();
    expect(screen.getByLabelText("I have the right to convert this book")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  });

  test("review panel shows placeholder text when no analysis loaded", () => {
    render(<App />);
    expect(screen.getByText("Run analysis first to see the character table and make corrections.")).toBeInTheDocument();
  });
});
