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
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  });
});
