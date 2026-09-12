import type * as Monaco from "monaco-editor";
import { snippetsFor } from "../store/workspaceConfigStore.ts";

/** Offering the repository's snippets as completions. plan.md §10.9.
 *
 *  Registered once per language, against `snippetsFor` rather than against a
 *  captured list — so a `.code-snippets` file that is edited and saved takes
 *  effect on the next keystroke rather than on the next reload. A provider that
 *  closed over the snippets would be a provider that goes stale silently, which
 *  is the failure mode people diagnose as "snippets don't work".
 *
 *  The bodies are passed through untranslated: Monaco understands VS Code's own
 *  `$1` / `${1:name}` / `${1|a,b|}` syntax, so `InsertAsSnippet` is both less
 *  code and more correct than any translation of it.
 */

const registered = new Map<string, Monaco.IDisposable>();

export function registerSnippets(monaco: typeof Monaco, language: string): void {
  // Once per language. Registering twice offers every snippet twice, which
  // reads as a duplicate-suggestions bug.
  if (registered.has(language)) return;

  const disposable = monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems: (model, position) => {
      const snippets = snippetsFor(language);
      if (snippets.length === 0) return { suggestions: [] };

      // The word under the cursor, so the range a completion replaces is the
      // prefix somebody has already typed rather than nothing.
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: snippets.map((snippet) => ({
          label: snippet.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules:
            monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: snippet.description,
          detail: "Workspace snippet",
          range,
        })),
      };
    },
  });

  registered.set(language, disposable);
}

/** For a test, and for a hot reload that would otherwise stack providers. */
export function disposeSnippets(): void {
  for (const disposable of registered.values()) disposable.dispose();
  registered.clear();
}
