// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette.tsx";
import type { Command } from "../../../lib/commands.ts";

const start = vi.fn();
const stop = vi.fn();
const settings = vi.fn();

function commands(): Command[] {
  return [
    {
      id: "run.start",
      category: "Run",
      title: "Start the dev server",
      keys: "Ctrl+R",
      run: start,
    },
    {
      id: "run.stop",
      category: "Run",
      title: "Stop the dev server",
      enabled: false,
      disabledReason: "Needs edit access",
      run: stop,
    },
    {
      id: "editor.settings",
      category: "Editor",
      title: "Editor settings…",
      run: settings,
    },
  ];
}

function open(onClose = vi.fn()) {
  render(<CommandPalette open onClose={onClose} commands={commands()} />);
  return onClose;
}

/** The palette renders into a portal, so queries go through screen. */
function row(id: string) {
  return document.querySelector(`[data-command="${id}"]`);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("lists every command when nothing is typed", () => {
    open();
    expect(screen.getByText("Start the dev server")).toBeDefined();
    expect(screen.getByText("Stop the dev server")).toBeDefined();
    expect(screen.getByText("Editor settings…")).toBeDefined();
  });

  it("shows a command's shortcut", () => {
    open();
    expect(screen.getByText("Ctrl+R")).toBeDefined();
  });

  it("filters as you type", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "settings" },
    });

    expect(screen.getByText("Editor settings…")).toBeDefined();
    expect(screen.queryByText("Start the dev server")).toBeNull();
  });

  it("says so when nothing matches", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Run a command…"), {
      target: { value: "zzzz" },
    });

    expect(screen.getByText("No matching commands")).toBeDefined();
  });

  it("runs a clicked command and closes", () => {
    const onClose = open();
    fireEvent.click(screen.getByText("Start the dev server"));

    expect(start).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("runs the highlighted command on Enter", () => {
    open();
    fireEvent.keyDown(screen.getByPlaceholderText("Run a command…"), {
      key: "Enter",
    });

    // The first entry is highlighted to begin with.
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("moves the highlight with the arrow keys", () => {
    open();
    const input = screen.getByPlaceholderText("Run a command…");

    // Down twice reaches the third entry, since the second is still selectable.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(settings).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not run past the end of the list", () => {
    open();
    const input = screen.getByPlaceholderText("Run a command…");
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("does not run past the start of the list", () => {
    open();
    const input = screen.getByPlaceholderText("Run a command…");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled command with its reason rather than hiding it", () => {
    open();
    expect(screen.getByText("Needs edit access")).toBeDefined();
    expect(row("run.stop")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("refuses to run a disabled command", () => {
    const onClose = open();
    fireEvent.click(screen.getByText("Stop the dev server"));

    expect(stop).not.toHaveBeenCalled();
    // And the palette stays open, so the reason is still readable.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes before running, so a command may open its own dialog", () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const run = vi.fn(() => order.push("run"));

    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[{ id: "x", category: "C", title: "Opens a dialog", run }]}
      />,
    );

    fireEvent.click(screen.getByText("Opens a dialog"));
    expect(order).toEqual(["close", "run"]);
  });
});
