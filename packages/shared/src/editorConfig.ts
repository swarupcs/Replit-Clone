/** Settings, keybindings and snippets that live in FILES. plan.md §10.9.
 *
 *  §2.49 put the editor session against the account, so it follows the person
 *  between machines. This is the other half, and §13.11 was careful to say the
 *  two are not the same thing: this one is about settings that are
 *  *committable* — diffable, reviewable, per-workspace, and importable from a
 *  real VS Code profile, because they use VS Code's own names.
 *
 *  **The precedence, which is VS Code's and is the only part worth arguing
 *  about:** built-in defaults, then the account's settings (§2.49), then the
 *  workspace's `.vscode/settings.json`. The most specific thing anybody said
 *  wins, and a file committed to the repository is more specific than a
 *  preference the person carries everywhere.
 */

/** Where a setting came from. On the wire because the settings screen has to
 *  be able to say "this one is coming from the repository" — otherwise
 *  somebody drags a slider, watches it snap back, and concludes the editor is
 *  broken. */
export type SettingOrigin = "default" | "account" | "workspace";

export interface WorkspaceSnippet {
  /** What the user types. */
  prefix: string;
  /** The snippet body, with VS Code's `$1`/`${1:name}` tab stops intact —
   *  Monaco understands the same syntax, so it is passed through rather than
   *  translated. */
  body: string;
  description?: string;
  /** Language ids this applies to. Empty means every language, which is what
   *  a `.code-snippets` file with no scope means. */
  languages: string[];
}

export interface EditorConfig {
  /** The merged settings, in this platform's own names. */
  settings: Record<string, string | number | boolean>;
  /** Which layer each merged setting came from. */
  origins: Record<string, SettingOrigin>;
  /** Command id to chord, from `.vscode/keybindings.json`. */
  keybindings: Record<string, string>;
  snippets: WorkspaceSnippet[];
  /** Problems with the files themselves — a settings.json that is not JSON, a
   *  setting this platform does not have. Reported rather than swallowed: a
   *  file that silently does nothing is the worst of the three outcomes. */
  problems: { file: string; message: string }[];
}

/** The file paths this reads, relative to the project root. */
export const EDITOR_CONFIG_FILES = {
  settings: ".vscode/settings.json",
  keybindings: ".vscode/keybindings.json",
  /** Any `.code-snippets` file in `.vscode/`. */
  snippetsDir: ".vscode",
} as const;
