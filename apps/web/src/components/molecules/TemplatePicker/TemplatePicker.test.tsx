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

/** Starter or Latest (plan.md Part A).
 *
 *  A starter is a committed directory: instant, offline, and pinned to whatever
 *  was committed. Latest runs the upstream scaffolder in the project's
 *  container: current, but it needs the network and takes minutes. Both are
 *  real answers, which is why this is a choice somebody makes rather than a
 *  heuristic — and why the control has to say what each one costs.
 */
describe("choosing how it gets built", () => {
  const withLatest = template("react-vite", "React (Vite)");
  withLatest.latestAvailable = true;

  function show(props: Partial<Parameters<typeof TemplatePicker>[0]> = {}) {
    return render(
      <TemplatePicker
        templates={[withLatest, template("go-http", "Go (net/http)")]}
        value="react-vite"
        onChange={() => undefined}
        variant="starter"
        onVariantChange={() => undefined}
        {...props}
      />,
    );
  }

  it("is offered for a template that has a recipe", () => {
    show();

    expect(screen.getByLabelText("How to build it")).toBeTruthy();
  });

  /** A toggle on `go-http`, where "latest" means nothing, is a control that
   *  does nothing. The server answers this from its recipe table, so a recipe
   *  turned off also removes the option that would now fail. */
  it("is not offered for a template that has none", () => {
    show({ value: "go-http" });

    expect(screen.queryByLabelText("How to build it")).toBeNull();
  });

  /** Callers that do not offer the choice get no toggle rather than a disabled
   *  one, because a disabled control invites somebody to look for how to
   *  enable it. */
  it("is not rendered at all when the caller does not offer it", () => {
    show({ onVariantChange: undefined });

    expect(screen.queryByLabelText("How to build it")).toBeNull();
  });

  it("reports the choice", () => {
    const onVariantChange = vi.fn();
    show({ onVariantChange });

    fireEvent.click(screen.getByText("Latest"));

    expect(onVariantChange).toHaveBeenCalledWith("latest");
  });

  /** The difference between them is invisible anywhere else until one of them
   *  takes two minutes, so the control is where it has to be said. */
  it("says what each one costs", () => {
    const { rerender } = show();
    expect(screen.getByText(/ready instantly and works offline/i)).toBeTruthy();

    rerender(
      <TemplatePicker
        templates={[withLatest]}
        value="react-vite"
        onChange={() => undefined}
        variant="latest"
        onVariantChange={() => undefined}
      />,
    );
    expect(screen.getByText(/needs the network/i)).toBeTruthy();
  });
});
