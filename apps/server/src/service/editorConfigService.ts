import fsp from "node:fs/promises";
import type {
  EditorConfig,
  SettingOrigin,
  WorkspaceSnippet,
} from "@replit-clone/shared";
import { EDITOR_CONFIG_FILES } from "@replit-clone/shared";
import { logger } from "../lib/logger.js";
import { resolveInProject } from "../utils/projectPaths.js";

/** Reading settings, keybindings and snippets out of the repository.
 *  plan.md §10.9.
 *
 *  **The names are VS Code's, on purpose.** `editor.fontSize`, not `fontSize`.
 *  That is the entire "bring an existing profile across" half of this row: a
 *  `settings.json` somebody already has should do something when pasted in,
 *  and a settings file written here should not be nonsense in a real VS Code.
 *  The mapping below is where the two vocabularies meet, and it is a table
 *  rather than a convention so that a name this platform has no equivalent for
 *  is REPORTED instead of silently dropped.
 *
 *  **Everything here fails soft.** A `settings.json` that is not JSON must not
 *  stop a project opening — being locked out of a project by a file you are
 *  trying to fix is the worst failure available, the same rule the devcontainer
 *  path already follows. So a broken file becomes a `problem` on the response
 *  and the editor keeps the settings it had.
 */

/** VS Code's name to ours, with what a value must look like.
 *
 *  Only the settings this editor actually has. A `settings.json` mentioning
 *  `editor.cursorBlinking` gets told this platform does not have it, which is
 *  a better answer than appearing to accept it.
 */
const SETTING_MAP: Record<
  string,
  { key: string; type: "number" | "boolean" | "string"; values?: string[] }
> = {
  "editor.fontSize": { key: "fontSize", type: "number" },
  "editor.tabSize": { key: "tabSize", type: "number" },
  // VS Code's real four, not the two this editor happens to have. Refusing
  // `bounded` because Monaco is driven by a boolean here would be refusing a
  // valid line of somebody's real profile -- anything that is not "off" wraps.
  "editor.wordWrap": {
    key: "wordWrap",
    type: "string",
    values: ["on", "off", "wordWrapColumn", "bounded"],
  },
  "editor.minimap.enabled": { key: "minimap", type: "boolean" },
  // Likewise: `relative` and `interval` are real VS Code values, and both mean
  // the gutter is shown.
  "editor.lineNumbers": {
    key: "lineNumbers",
    type: "string",
    values: ["on", "off", "relative", "interval"],
  },
  "editor.formatOnSave": { key: "formatOnSave", type: "boolean" },
  "editor.formatOnPaste": { key: "formatOnPaste", type: "boolean" },
  "editor.formatOnType": { key: "formatOnType", type: "boolean" },
  "editor.bracketPairColorization.enabled": {
    key: "bracketPairColorization",
    type: "boolean",
  },
  "editor.stickyScroll.enabled": { key: "stickyScroll", type: "boolean" },
  "editor.inlayHints.enabled": {
    key: "inlayHints",
    type: "string",
    values: ["on", "off", "offUnlessPressed", "onUnlessPressed"],
  },
  "editor.inlineSuggest.enabled": { key: "inlineSuggest", type: "boolean" },
  "editor.renderWhitespace": {
    key: "renderWhitespace",
    type: "string",
    values: ["none", "selection", "all", "boundary", "trailing"],
  },
  "editor.cursorSurroundingLines": { key: "cursorSurroundingLines", type: "number" },
  "editor.rulers": { key: "rulers", type: "boolean" },
};

/** A settings file larger than this is not a settings file. */
const MAX_FILE_BYTES = 256 * 1024;

async function readIfPresent(
  projectId: string,
  relPath: string,
): Promise<string | null> {
  try {
    const absolute = resolveInProject(projectId, relPath);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fsp.readFile(absolute, "utf8");
  } catch {
    // Absent, unreadable, or outside the project. All three mean "no
    // workspace settings", which is the ordinary case.
    return null;
  }
}

/** JSON with comments and trailing commas, which is what VS Code actually
 *  writes and what anybody pasting a real `settings.json` will bring.
 *
 *  Not a parser: a pre-pass that removes what standard JSON refuses, then
 *  `JSON.parse`. Strings are respected, because `"https://x"` is not a comment
 *  and treating it as one is the classic way this goes wrong.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let escape = false;
  let comment: "" | "line" | "block" = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (comment === "line") {
      if (char === "\n") {
        comment = "";
        out += char;
      }
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = "";
        index += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      comment = "line";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      index += 1;
      continue;
    }

    out += char;
  }

  // Trailing commas, once comments are gone so a comma before a comment is
  // still seen as trailing.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as unknown;
}

/** Converts VS Code's values to this editor's.
 *
 *  Two of them differ in kind rather than in name — VS Code's `wordWrap` and
 *  `lineNumbers` are strings where this editor has booleans — and that is
 *  exactly the sort of thing a mapping table exists to absorb rather than
 *  leave to whoever writes the file.
 */
function convert(
  vsName: string,
  raw: unknown,
): { key: string; value: string | number | boolean } | { error: string } {
  const spec = SETTING_MAP[vsName];
  if (!spec) return { error: `${vsName} is not a setting this editor has` };

  if (spec.type === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { error: `${vsName} must be a number` };
    }
    return { key: spec.key, value: raw };
  }

  if (spec.type === "boolean") {
    if (typeof raw !== "boolean") return { error: `${vsName} must be true or false` };
    return { key: spec.key, value: raw };
  }

  if (typeof raw === "boolean") {
    // VS Code accepts `"editor.wordWrap": true` from older files.
    return { key: spec.key, value: raw };
  }
  if (typeof raw !== "string") {
    return { error: `${vsName} must be text` };
  }
  if (spec.values && !spec.values.includes(raw)) {
    return { error: `"${raw}" is not a value ${vsName} accepts` };
  }

  // The three that are a string in VS Code and a boolean here.
  if (spec.key === "wordWrap") return { key: spec.key, value: raw !== "off" };
  if (spec.key === "lineNumbers") return { key: spec.key, value: raw !== "off" };
  if (spec.key === "inlayHints") return { key: spec.key, value: raw !== "off" };

  return { key: spec.key, value: raw };
}

export interface ParsedSettings {
  settings: Record<string, string | number | boolean>;
  problems: string[];
}

export function settingsFrom(raw: unknown): ParsedSettings {
  const settings: Record<string, string | number | boolean> = {};
  const problems: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings, problems: ["settings.json must contain a JSON object"] };
  }

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // A section this editor has no opinion about at all -- `files.*`,
    // `terminal.*`, an extension's own namespace. Skipped in silence, because
    // reporting every line of somebody's real profile as a problem would bury
    // the one line that IS a problem.
    if (!name.startsWith("editor.")) continue;

    const converted = convert(name, value);
    if ("error" in converted) {
      problems.push(converted.error);
      continue;
    }
    settings[converted.key] = converted.value;
  }

  return { settings, problems };
}

/** The shell a terminal should open with, from `.vscode/settings.json`.
 *  plan.md §10.14.
 *
 *  VS Code spells this as a profile NAME
 *  (`terminal.integrated.defaultProfile.linux`) plus a profiles map that gives
 *  each name a `path`. Both are read, because a settings file that names a
 *  profile without defining one is common — the name refers to a profile VS
 *  Code ships, and the shells it ships are the ones already in the allowlist.
 *
 *  Returns null when nothing is said, which is different from saying bash: the
 *  caller's default is the one place that decision lives.
 */
export function terminalShellFrom(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const settings = raw as Record<string, unknown>;

  const name = settings["terminal.integrated.defaultProfile.linux"];
  if (typeof name !== "string" || name.trim() === "") return null;

  const profiles = settings["terminal.integrated.profiles.linux"];
  if (typeof profiles === "object" && profiles !== null) {
    const profile = (profiles as Record<string, unknown>)[name];
    if (typeof profile === "object" && profile !== null) {
      const path = (profile as { path?: unknown }).path;
      // VS Code allows `path` to be a string or a list of candidates.
      if (typeof path === "string") return path;
      if (Array.isArray(path)) {
        const first = path.find((entry): entry is string => typeof entry === "string");
        if (first !== undefined) return first;
      }
    }
  }

  // No profile defined: the name is one of VS Code's built-ins, which are
  // named after the shell. `/bin/<name>` is what those resolve to, and the
  // allowlist decides whether it is one this platform will run.
  return `/bin/${name}`;
}

/** `.vscode/keybindings.json`, which VS Code has only at the user level.
 *
 *  Read per-workspace here, deliberately and as a departure: this row's whole
 *  point is settings that are committable, and a keybinding that belongs to a
 *  project ("F5 runs THIS thing") is exactly the kind somebody wants in the
 *  repository. The account's own bindings still apply; a workspace file wins
 *  where both name a command, on the same specificity argument as settings.
 */
export function keybindingsFrom(raw: unknown): {
  keybindings: Record<string, string>;
  problems: string[];
} {
  const keybindings: Record<string, string> = {};
  const problems: string[] = [];

  if (!Array.isArray(raw)) {
    return { keybindings, problems: ["keybindings.json must contain a JSON array"] };
  }

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, command } = entry as { key?: unknown; command?: unknown };

    if (typeof key !== "string" || typeof command !== "string") {
      problems.push("every keybinding needs a `key` and a `command`");
      continue;
    }
    // A leading `-` is VS Code's "remove this default". Honoured as a removal
    // by mapping to the empty chord, because silently binding a command to the
    // literal string "-workbench.action.x" would be worse than ignoring it.
    if (command.startsWith("-")) {
      keybindings[command.slice(1)] = "";
      continue;
    }
    keybindings[command] = key;
  }

  return { keybindings, problems };
}

/** `.code-snippets` files, in VS Code's own shape. */
export function snippetsFrom(
  raw: unknown,
  file: string,
): { snippets: WorkspaceSnippet[]; problems: string[] } {
  const snippets: WorkspaceSnippet[] = [];
  const problems: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { snippets, problems: [`${file} must contain a JSON object`] };
  }

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as {
      prefix?: unknown;
      body?: unknown;
      description?: unknown;
      scope?: unknown;
    };

    if (typeof entry.prefix !== "string") {
      problems.push(`the snippet "${name}" has no prefix`);
      continue;
    }

    // VS Code allows a string or an array of lines, and real files use both.
    const body = Array.isArray(entry.body)
      ? entry.body.filter((line): line is string => typeof line === "string").join("\n")
      : typeof entry.body === "string"
        ? entry.body
        : null;

    if (body === null) {
      problems.push(`the snippet "${name}" has no body`);
      continue;
    }

    snippets.push({
      prefix: entry.prefix,
      body,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      languages:
        typeof entry.scope === "string"
          ? entry.scope.split(",").map((part) => part.trim()).filter(Boolean)
          : [],
    });
  }

  return { snippets, problems };
}

/** Everything the repository says about the editor.
 *
 *  `accountSettings` is what §2.49 already syncs; it is merged here rather than
 *  on the client so that "which layer won" is decided in one place and can be
 *  reported.
 */
export async function readEditorConfig(
  projectId: string,
  accountSettings: Record<string, string | number | boolean> = {},
): Promise<EditorConfig> {
  const problems: EditorConfig["problems"] = [];
  const origins: Record<string, SettingOrigin> = {};
  const settings: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(accountSettings)) {
    settings[key] = value;
    origins[key] = "account";
  }

  const settingsText = await readIfPresent(projectId, EDITOR_CONFIG_FILES.settings);
  if (settingsText !== null) {
    try {
      const parsed = settingsFrom(parseJsonc(settingsText));
      for (const message of parsed.problems) {
        problems.push({ file: EDITOR_CONFIG_FILES.settings, message });
      }
      for (const [key, value] of Object.entries(parsed.settings)) {
        settings[key] = value;
        // The workspace wins: a file committed to the repository is more
        // specific than a preference the person carries everywhere.
        origins[key] = "workspace";
      }
    } catch (error) {
      problems.push({
        file: EDITOR_CONFIG_FILES.settings,
        message: error instanceof Error ? error.message : "could not be read",
      });
    }
  }

  let keybindings: Record<string, string> = {};
  const keysText = await readIfPresent(projectId, EDITOR_CONFIG_FILES.keybindings);
  if (keysText !== null) {
    try {
      const parsed = keybindingsFrom(parseJsonc(keysText));
      keybindings = parsed.keybindings;
      for (const message of parsed.problems) {
        problems.push({ file: EDITOR_CONFIG_FILES.keybindings, message });
      }
    } catch (error) {
      problems.push({
        file: EDITOR_CONFIG_FILES.keybindings,
        message: error instanceof Error ? error.message : "could not be read",
      });
    }
  }

  const snippets = await readSnippets(projectId, problems);

  return { settings, origins, keybindings, snippets, problems };
}

async function readSnippets(
  projectId: string,
  problems: EditorConfig["problems"],
): Promise<WorkspaceSnippet[]> {
  const snippets: WorkspaceSnippet[] = [];

  let names: string[];
  try {
    const dir = resolveInProject(projectId, EDITOR_CONFIG_FILES.snippetsDir);
    names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".code-snippets"));
  } catch {
    return snippets;
  }

  // A cap, because this reads every matching file and a repository can contain
  // any number of them.
  for (const name of names.slice(0, 20)) {
    const relPath = `${EDITOR_CONFIG_FILES.snippetsDir}/${name}`;
    const text = await readIfPresent(projectId, relPath);
    if (text === null) continue;

    try {
      const parsed = snippetsFrom(parseJsonc(text), relPath);
      snippets.push(...parsed.snippets);
      for (const message of parsed.problems) problems.push({ file: relPath, message });
    } catch (error) {
      problems.push({
        file: relPath,
        message: error instanceof Error ? error.message : "could not be read",
      });
    }
  }

  if (snippets.length > 0) {
    logger.debug("read workspace snippets", { projectId, count: snippets.length });
  }
  return snippets;
}

/** The shell this project's terminals should open with, or null.
 *
 *  Separate from `readEditorConfig` because the caller is different: that one
 *  serves the editor over HTTP, and this one is asked by the terminal gateway
 *  as a shell is created. Reading the whole config there would be three file
 *  reads to answer one question.
 */
export async function projectTerminalShell(
  projectId: string,
): Promise<string | null> {
  const text = await readIfPresent(projectId, EDITOR_CONFIG_FILES.settings);
  if (text === null) return null;

  try {
    return terminalShellFrom(parseJsonc(text));
  } catch {
    // A settings file that is not JSON must not stop a terminal opening. The
    // editor's own config endpoint reports the parse error; this path is not
    // the place to surface it.
    return null;
  }
}
