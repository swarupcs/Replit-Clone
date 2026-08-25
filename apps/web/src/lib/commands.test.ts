import { describe, expect, it, vi } from "vitest";
import { filterCommands } from "./commands.ts";
import type { Command } from "./commands.ts";

function command(id: string, category: string, title: string): Command {
  return { id, category, title, run: vi.fn() };
}

const COMMANDS: Command[] = [
  command("run.start", "Run", "Start the dev server"),
  command("run.stop", "Run", "Stop the dev server"),
  command("view.sidebar", "View", "Toggle sidebar"),
  command("git.commit", "Source control", "Commit staged changes"),
  command("file.quickOpen", "Go", "Go to file…"),
];

describe("filterCommands", () => {
  it("keeps declaration order for an empty query", () => {
    expect(filterCommands(COMMANDS, "").map((entry) => entry.id)).toEqual([
      "run.start",
      "run.stop",
      "view.sidebar",
      "git.commit",
      "file.quickOpen",
    ]);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterCommands(COMMANDS, "   ")).toHaveLength(COMMANDS.length);
  });

  it("matches on the title", () => {
    const ids = filterCommands(COMMANDS, "sidebar").map((entry) => entry.id);
    expect(ids).toEqual(["view.sidebar"]);
  });

  it("matches on the category, which the title need not repeat", () => {
    // "Commit staged changes" says nothing about git.
    const ids = filterCommands(COMMANDS, "source").map((entry) => entry.id);
    expect(ids).toContain("git.commit");
  });

  it("drops commands that do not match at all", () => {
    expect(filterCommands(COMMANDS, "zzzz")).toEqual([]);
  });

  it("keeps disabled commands, rather than hiding them", () => {
    const withDisabled: Command[] = [
      { ...command("run.stop", "Run", "Stop the dev server"), enabled: false },
    ];
    expect(filterCommands(withDisabled, "stop")).toHaveLength(1);
  });

  it("ranks a closer match first", () => {
    const ids = filterCommands(COMMANDS, "stop").map((entry) => entry.id);
    expect(ids[0]).toBe("run.stop");
  });

  it("caps a long list", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      command(`c${String(index)}`, "Bulk", `Command ${String(index)}`),
    );
    expect(filterCommands(many, "").length).toBeLessThanOrEqual(50);
    expect(filterCommands(many, "command").length).toBeLessThanOrEqual(50);
  });
});
