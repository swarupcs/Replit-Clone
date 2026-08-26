import type { Monaco } from "@monaco-editor/react";

/** Monaco's language service only knows about files it has models for, and the
 *  editor creates one only when a tab opens. So go-to-definition could reach a
 *  symbol defined in a file the user had already found, and nothing else —
 *  useless for exactly the case it exists to serve.
 *
 *  These are the models for every OTHER source file: created without an editor
 *  attached, purely so the worker can see them.
 *
 *  They are kept in their own registry rather than the editor's. That one is
 *  swept against the open tabs (`disposeUnwantedModels`), so a background model
 *  registered there would be disposed the moment the next tab closed — taking
 *  the navigation with it.
 */
const background = new Map<string, { dispose: () => void }>();

/** Extension → Monaco language id, for the handful this ships. */
function languageFor(relPath: string): string {
  if (/\.tsx$/.test(relPath)) return "typescript";
  if (/\.(ts|mts|cts)$/.test(relPath)) return "typescript";
  if (/\.jsx$/.test(relPath)) return "javascript";
  return "javascript";
}

/** Compiler options the worker needs before any of this helps.
 *
 *  Monaco's defaults do not enable JSX, so every `.tsx` file parsed as a syntax
 *  error and resolved nothing; and without node module resolution an import of
 *  `./util` never finds `./util.ts`. `allowJs` so a JavaScript project gets the
 *  same navigation a TypeScript one does.
 *
 *  `noSemanticValidation` because these are other people's project files: the
 *  worker should answer questions about them, not underline them in red for
 *  missing types it was never given.
 */
function configure(monaco: Monaco): void {
  const ts = monaco.languages.typescript;

  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.ESNext,
    });

    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  }
}

export interface SourceFile {
  relPath: string;
  contents: string;
}

/** Gives the language service the project's other files.
 *
 *  A file that already has a model is skipped rather than overwritten: that
 *  model belongs to an open tab, may hold unsaved edits, and is the version the
 *  user is actually looking at.
 *
 *  Returns how many models were added, which is what makes this observable to a
 *  test without reaching into Monaco's registry.
 */
export function installProjectSources(
  monaco: Monaco,
  files: SourceFile[],
): number {
  configure(monaco);

  let added = 0;

  for (const file of files) {
    // The same URI shape the editor builds for an open tab, so a file that
    // later opens finds this model rather than creating a second one for the
    // same path -- which Monaco refuses outright.
    const uri = monaco.Uri.from({ scheme: "inmemory", path: `/${file.relPath}` });

    if (monaco.editor.getModel(uri)) continue;

    background.set(
      uri.toString(),
      monaco.editor.createModel(file.contents, languageFor(file.relPath), uri),
    );
    added += 1;
  }

  return added;
}

/** Drops every background model. Called when the project changes: the next
 *  project's files are different ones, and holding the last project's contents
 *  would let a definition lookup land in a file that is no longer there. */
export function clearProjectSources(): void {
  for (const model of background.values()) model.dispose();
  background.clear();
}
