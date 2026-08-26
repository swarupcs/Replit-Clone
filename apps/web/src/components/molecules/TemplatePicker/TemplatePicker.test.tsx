// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TemplateSummary } from "@replit-clone/shared";
import { TemplatePicker } from "./TemplatePicker.tsx";

function template(id: string, label: string): TemplateSummary {
  return {
    id,
    label,
    devPort: 5173,
    previewPorts: [5173],
    startCommand: "npm run dev",
  };
}

/** Deliberately out of group order, so the ordering assertion means something. */
const TEMPLATES: TemplateSummary[] = [
  template("go-http", "Go (net/http)"),
  template("react-vite", "React (Vite)"),
  template("static-html", "Static HTML"),
  template("nextjs", "Next.js"),
];

afterEach(() => {
  cleanup();
});

describe("TemplatePicker", () => {
  it("groups templates by what they are for, in a fixed order", () => {
    render(
      <TemplatePicker templates={TEMPLATES} value="react-vite" onChange={vi.fn()} />,
    );

    const headings = screen
      .getAllByText(/^(Frontend|Fullstack|Backend|Static)$/)
      .map((node) => node.textContent);

    // Not the order the API returned them in.
    expect(headings).toEqual(["Frontend", "Fullstack", "Backend", "Static"]);
  });

  it("marks exactly one card as chosen", () => {
    render(
      <TemplatePicker templates={TEMPLATES} value="nextjs" onChange={vi.fn()} />,
    );

    const checked = screen
      .getAllByRole("radio")
      .filter((node) => node.getAttribute("aria-checked") === "true");

    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toContain("Next.js");
  });

  it("reports the template that was clicked", () => {
    const onChange = vi.fn();
    render(
      <TemplatePicker
        templates={TEMPLATES}
        value="react-vite"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText("Go (net/http)"));

    expect(onChange).toHaveBeenCalledWith("go-http");
  });

  it("moves the selection with the arrow keys", () => {
    const onChange = vi.fn();
    render(
      <TemplatePicker
        templates={TEMPLATES}
        value="react-vite"
        onChange={onChange}
      />,
    );

    // Next in the source list, not the next card on screen — the list is the
    // order a keyboard walks.
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("static-html");

    onChange.mockClear();
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("go-http");
  });

  it("stays put at either end rather than wrapping round", () => {
    const onChange = vi.fn();
    render(
      <TemplatePicker
        templates={TEMPLATES}
        value="go-http"
        onChange={onChange}
      />,
    );

    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps only the chosen card in the tab order", () => {
    render(
      <TemplatePicker templates={TEMPLATES} value="nextjs" onChange={vi.fn()} />,
    );

    // Tabbing past the picker should take one press, not one per template.
    const reachable = screen
      .getAllByRole("radio")
      .filter((node) => node.getAttribute("tabindex") === "0");

    expect(reachable).toHaveLength(1);
  });

  it("still renders a template the look-up table has never heard of", () => {
    render(
      <TemplatePicker
        templates={[template("rust-axum", "Rust (Axum)")]}
        value="rust-axum"
        onChange={vi.fn()}
      />,
    );

    // A registry that gains a template must not lose it in the UI.
    expect(screen.getByText("Rust (Axum)")).toBeDefined();
  });
});
