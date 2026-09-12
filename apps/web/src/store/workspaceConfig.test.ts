// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { EditorConfig } from "@replit-clone/shared";
import {
  snippetsFor,
  useWorkspaceConfigStore,
  withWorkspace,
} from "./workspaceConfigStore.ts";

function config(over: Partial<EditorConfig> = {}): EditorConfig {
  return {
    settings: {},
    origins: {},
    keybindings: {},
    snippets: [],
    problems: [],
    ...over,
  };
}

beforeEach(() => {
  useWorkspaceConfigStore.setState({ config: null });
});

describe("what the repository says about the editor", () => {
  it("leaves a setting alone when no file mentions it", () => {
    expect(withWorkspace(14, "fontSize")).toBe(14);
  });

  it("lets the workspace file win", () => {
    useWorkspaceConfigStore.setState({ config: config({ settings: { fontSize: 18 } }) });
    // A file committed to the repository is a more specific statement than a
    // preference somebody carries between machines.
    expect(withWorkspace(14, "fontSize")).toBe(18);
  });

  it("does not write the workspace value into the person's own settings", () => {
    // Opening a project with a settings.json must not permanently change your
    // settings everywhere, including in projects that never asked.
    useWorkspaceConfigStore.setState({ config: config({ settings: { fontSize: 18 } }) });
    withWorkspace(14, "fontSize");

    useWorkspaceConfigStore.setState({ config: null });
    expect(withWorkspace(14, "fontSize")).toBe(14);
  });

  it("takes a false from a file rather than treating it as absent", () => {
    // `?? own` would have made "minimap: false" mean "no opinion".
    useWorkspaceConfigStore.setState({ config: config({ settings: { minimap: false } }) });
    expect(withWorkspace(true, "minimap")).toBe(false);
  });
});

describe("which snippets apply", () => {
  const snippets = [
    { prefix: "log", body: "1", languages: ["javascript"] },
    { prefix: "todo", body: "2", languages: [] },
    { prefix: "def", body: "3", languages: ["python"] },
  ];

  beforeEach(() => {
    useWorkspaceConfigStore.setState({ config: config({ snippets }) });
  });

  it("offers a scoped snippet only in its language", () => {
    expect(snippetsFor("javascript").map((s) => s.prefix)).toEqual(["log", "todo"]);
  });

  it("offers an unscoped snippet everywhere", () => {
    // Which is what a `.code-snippets` file with no `scope` means in VS Code.
    expect(snippetsFor("rust").map((s) => s.prefix)).toEqual(["todo"]);
  });

  it("is empty when no project is open", () => {
    useWorkspaceConfigStore.setState({ config: null });
    expect(snippetsFor("javascript")).toEqual([]);
  });
});
