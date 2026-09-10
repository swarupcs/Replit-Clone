import { create } from "zustand";
import type { EditorConfig, WorkspaceSnippet } from "@replit-clone/shared";

/** What the repository says about the editor. plan.md §10.9.
 *
 *  Deliberately NOT merged into `editorSettingsStore`. That store is the
 *  person's own preferences and it persists — through §2.49, to the account.
 *  These come from files in a repository, they are not this person's to keep,
 *  and writing them into that store would mean opening a project with a
 *  `settings.json` permanently changed your settings everywhere, including in
 *  projects that never asked. So: a second store, read at the point of use,
 *  with the workspace winning.
 */
interface WorkspaceConfigStore {
  /** Null until a project is open and its config has been read. */
  config: EditorConfig | null;
  setConfig: (config: EditorConfig | null) => void;
}

export const useWorkspaceConfigStore = create<WorkspaceConfigStore>((set) => ({
  config: null,
  setConfig: (config) => {
    set({ config });
  },
}));

/** One setting, with the workspace file taking precedence.
 *
 *  The whole merge is one function so the precedence is stated once. VS Code's
 *  own order, and the argument for it is that a file committed to the
 *  repository is a more specific statement than a preference somebody carries
 *  between machines.
 */
export function withWorkspace<T extends string | number | boolean>(
  own: T,
  key: string,
): T {
  const value = useWorkspaceConfigStore.getState().config?.settings[key];
  return value === undefined ? own : (value as T);
}

/** The snippets that apply to a language.
 *
 *  A snippet with no scope applies everywhere, which is what a `.code-snippets`
 *  file with no `scope` means in VS Code.
 */
export function snippetsFor(language: string): WorkspaceSnippet[] {
  const snippets = useWorkspaceConfigStore.getState().config?.snippets ?? [];
  return snippets.filter(
    (snippet) => snippet.languages.length === 0 || snippet.languages.includes(language),
  );
}
