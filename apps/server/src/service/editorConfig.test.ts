import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const roots = vi.hoisted(() => ({ current: "" }));
vi.mock("../utils/projectPaths.js", () => ({
  resolveInProject: (_projectId: string, relPath: string) =>
    path.join(roots.current, relPath),
}));

import {
  keybindingsFrom,
  terminalShellFrom,
  parseJsonc,
  readEditorConfig,
  settingsFrom,
  snippetsFrom,
} from "./editorConfigService.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const made: string[] = [];

async function project(files: Record<string, string>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-editorcfg-"));
  made.push(root);
  roots.current = root;

  for (const [relPath, body] of Object.entries(files)) {
    const absolute = path.join(root, relPath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, body);
  }
}

beforeEach(async () => {
  await project({});
});

afterEach(async () => {
  for (const root of made.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("reading what VS Code actually writes", () => {
  it("takes a file with comments in it", () => {
    // Which is what VS Code writes, and what anybody pasting a real
    // settings.json will bring.
    expect(
      parseJsonc('{\n  // my size\n  "editor.fontSize": 15 /* here */\n}'),
    ).toEqual({ "editor.fontSize": 15 });
  });

  it("takes a trailing comma", () => {
    expect(parseJsonc('{ "a": 1, }')).toEqual({ a: 1 });
  });

  it("does not treat a URL inside a string as a comment", () => {
    // The classic way this goes wrong.
    expect(parseJsonc('{ "a": "https://example.com/x" }')).toEqual({
      a: "https://example.com/x",
    });
  });

  it("does not treat an escaped quote as the end of a string", () => {
    expect(parseJsonc('{ "a": "say \\" // not a comment" }')).toEqual({
      a: 'say " // not a comment',
    });
  });

  it("still refuses something that is not JSON at all", () => {
    expect(() => parseJsonc("{ nope")).toThrow();
  });
});

describe("mapping VS Code's names to this editor's", () => {
  it("reads editor.fontSize", () => {
    expect(settingsFrom({ "editor.fontSize": 15 }).settings).toEqual({ fontSize: 15 });
  });

  it("turns wordWrap's string into this editor's boolean", () => {
    // The two differ in KIND, not only in name, which is what a mapping table
    // exists to absorb rather than leave to whoever writes the file.
    expect(settingsFrom({ "editor.wordWrap": "on" }).settings).toEqual({
      wordWrap: true,
    });
    expect(settingsFrom({ "editor.wordWrap": "off" }).settings).toEqual({
      wordWrap: false,
    });
  });

  it("reads lineNumbers, where anything but off means on", () => {
    expect(settingsFrom({ "editor.lineNumbers": "relative" }).settings).toEqual({
      lineNumbers: true,
    });
  });

  it("reads the nested names as they are actually spelled", () => {
    expect(settingsFrom({ "editor.minimap.enabled": true }).settings).toEqual({
      minimap: true,
    });
  });

  it("says so when a setting exists in VS Code and not here", () => {
    // Better than appearing to accept it.
    const parsed = settingsFrom({ "editor.cursorBlinking": "smooth" });
    expect(parsed.settings).toEqual({});
    expect(parsed.problems[0]).toMatch(/not a setting this editor has/);
  });

  it("says nothing about sections it has no opinion on", () => {
    // Reporting every line of somebody's real profile would bury the one line
    // that IS a problem.
    const parsed = settingsFrom({
      "files.autoSave": "afterDelay",
      "terminal.integrated.fontSize": 12,
      "editor.fontSize": 15,
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings).toEqual({ fontSize: 15 });
  });

  it("refuses a value of the wrong type", () => {
    expect(settingsFrom({ "editor.fontSize": "big" }).problems[0]).toMatch(
      /must be a number/,
    );
  });

  it("refuses a value outside an enum", () => {
    expect(settingsFrom({ "editor.renderWhitespace": "sometimes" }).problems[0]).toMatch(
      /is not a value/,
    );
  });

  it("refuses a file that is not an object", () => {
    expect(settingsFrom([1, 2]).problems[0]).toMatch(/must contain a JSON object/);
  });
});

describe("keybindings from the repository", () => {
  it("reads command and key", () => {
    expect(
      keybindingsFrom([{ key: "ctrl+shift+r", command: "run.toggle" }]).keybindings,
    ).toEqual({ "run.toggle": "ctrl+shift+r" });
  });

  it("reads VS Code's leading minus as a removal", () => {
    // Binding a command to the literal string "-run.toggle" would be worse
    // than ignoring the line.
    expect(keybindingsFrom([{ key: "f5", command: "-run.toggle" }]).keybindings).toEqual(
      { "run.toggle": "" },
    );
  });

  it("names an entry missing its halves", () => {
    expect(keybindingsFrom([{ key: "f5" }]).problems[0]).toMatch(/needs a/);
  });

  it("refuses a file that is not an array", () => {
    expect(keybindingsFrom({}).problems[0]).toMatch(/must contain a JSON array/);
  });
});

describe("snippets", () => {
  it("reads a body given as lines, which is how real files write them", () => {
    const { snippets } = snippetsFrom(
      { Log: { prefix: "log", body: ["console.log($1);", "$0"] } },
      "x.code-snippets",
    );
    expect(snippets[0]?.body).toBe("console.log($1);\n$0");
  });

  it("reads a body given as one string", () => {
    const { snippets } = snippetsFrom(
      { Log: { prefix: "log", body: "console.log($1);" } },
      "x.code-snippets",
    );
    expect(snippets[0]?.body).toBe("console.log($1);");
  });

  it("keeps the tab stops rather than translating them", () => {
    // Monaco understands VS Code's own syntax, so passing it through is both
    // less code and more correct than a translation.
    const { snippets } = snippetsFrom(
      { W: { prefix: "w", body: "${1:name}: ${2|a,b|}$0" } },
      "x.code-snippets",
    );
    expect(snippets[0]?.body).toContain("${1:name}");
  });

  it("reads a comma-separated scope as languages", () => {
    const { snippets } = snippetsFrom(
      { W: { prefix: "w", body: "x", scope: "javascript, typescript" } },
      "x.code-snippets",
    );
    expect(snippets[0]?.languages).toEqual(["javascript", "typescript"]);
  });

  it("treats no scope as every language", () => {
    const { snippets } = snippetsFrom({ W: { prefix: "w", body: "x" } }, "f");
    expect(snippets[0]?.languages).toEqual([]);
  });

  it("names one with no prefix rather than dropping it", () => {
    expect(snippetsFrom({ W: { body: "x" } }, "f").problems[0]).toMatch(/no prefix/);
  });
});

describe("the merged answer", () => {
  it("lets the workspace file win over the account", async () => {
    await project({ ".vscode/settings.json": '{ "editor.fontSize": 18 }' });

    // A file committed to the repository is more specific than a preference
    // the person carries everywhere.
    const config = await readEditorConfig(PROJECT, { fontSize: 12, tabSize: 4 });
    expect(config.settings.fontSize).toBe(18);
    expect(config.origins.fontSize).toBe("workspace");
  });

  it("keeps an account setting the workspace does not mention", async () => {
    await project({ ".vscode/settings.json": '{ "editor.fontSize": 18 }' });

    const config = await readEditorConfig(PROJECT, { tabSize: 4 });
    expect(config.settings.tabSize).toBe(4);
    expect(config.origins.tabSize).toBe("account");
  });

  it("says where each setting came from", async () => {
    // The settings screen has to be able to say "this is coming from the
    // repository", or somebody drags a slider, watches it snap back, and
    // concludes the editor is broken.
    await project({ ".vscode/settings.json": '{ "editor.tabSize": 8 }' });
    const config = await readEditorConfig(PROJECT, { tabSize: 2 });
    expect(config.origins.tabSize).toBe("workspace");
  });

  it("reports a broken file instead of failing", async () => {
    await project({ ".vscode/settings.json": "{ this is not json" });

    // Being locked out of a project by a file you are trying to fix is the
    // worst failure available here.
    const config = await readEditorConfig(PROJECT, { fontSize: 12 });
    expect(config.settings.fontSize).toBe(12);
    expect(config.problems[0]?.file).toBe(".vscode/settings.json");
  });

  it("is empty and quiet for a project with no .vscode at all", async () => {
    const config = await readEditorConfig(PROJECT);
    expect(config.settings).toEqual({});
    expect(config.problems).toEqual([]);
    expect(config.snippets).toEqual([]);
  });

  it("reads every .code-snippets file in .vscode", async () => {
    await project({
      ".vscode/one.code-snippets": '{ "A": { "prefix": "a", "body": "1" } }',
      ".vscode/two.code-snippets": '{ "B": { "prefix": "b", "body": "2" } }',
      ".vscode/notes.txt": "ignored",
    });

    const config = await readEditorConfig(PROJECT);
    expect(config.snippets.map((s) => s.prefix).sort()).toEqual(["a", "b"]);
  });

  it("reads keybindings from the repository", async () => {
    await project({
      ".vscode/keybindings.json": '[{ "key": "f5", "command": "run.toggle" }]',
    });

    const config = await readEditorConfig(PROJECT);
    expect(config.keybindings["run.toggle"]).toBe("f5");
  });
});

/** Terminal profiles. plan.md §10.14. */
describe("which shell a terminal opens", () => {
  it("says nothing when the file says nothing", () => {
    // Null rather than bash: the caller's default is the one place that
    // decision lives.
    expect(terminalShellFrom({})).toBeNull();
    expect(terminalShellFrom({ "editor.fontSize": 14 })).toBeNull();
  });

  it("reads a profile's path", () => {
    expect(
      terminalShellFrom({
        "terminal.integrated.defaultProfile.linux": "zsh",
        "terminal.integrated.profiles.linux": { zsh: { path: "/usr/bin/zsh" } },
      }),
    ).toBe("/usr/bin/zsh");
  });

  it("takes the first of a list of candidate paths, as VS Code allows", () => {
    expect(
      terminalShellFrom({
        "terminal.integrated.defaultProfile.linux": "bash",
        "terminal.integrated.profiles.linux": {
          bash: { path: ["/usr/local/bin/bash", "/bin/bash"] },
        },
      }),
    ).toBe("/usr/local/bin/bash");
  });

  it("resolves a built-in profile name that defines no profile", () => {
    // Common in real files: the name refers to a profile VS Code ships.
    expect(
      terminalShellFrom({ "terminal.integrated.defaultProfile.linux": "zsh" }),
    ).toBe("/bin/zsh");
  });

  it("hands back whatever was written, leaving the allowlist to the caller", () => {
    // Two jobs kept apart: this reads the file, `isAllowedShell` decides what
    // may run. A reader that also filtered would be a second place to change
    // when the list does.
    expect(
      terminalShellFrom({
        "terminal.integrated.defaultProfile.linux": "evil",
        "terminal.integrated.profiles.linux": { evil: { path: "/tmp/payload" } },
      }),
    ).toBe("/tmp/payload");
  });
});
