import { afterEach, describe, expect, it, vi } from "vitest";
import type { Monaco } from "@monaco-editor/react";
import { clearProjectSources, installProjectSources } from "./projectSources.ts";

/** Just the slice of Monaco this module touches. */
interface FakeModel {
  uri: string;
  contents: string;
  language: string;
  dispose: () => void;
}

function fakeMonaco() {
  const models = new Map<string, FakeModel>();
  const compilerOptions: Record<string, unknown>[] = [];
  const diagnosticsOptions: Record<string, unknown>[] = [];

  const defaults = () => ({
    getCompilerOptions: () => ({ strict: true }),
    setCompilerOptions: (options: Record<string, unknown>) => {
      compilerOptions.push(options);
    },
    setDiagnosticsOptions: (options: Record<string, unknown>) => {
      diagnosticsOptions.push(options);
    },
  });

  const monaco = {
    Uri: {
      from: ({ scheme, path }: { scheme: string; path: string }) => ({
        toString: () => `${scheme}://${path}`,
      }),
    },
    editor: {
      getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
      createModel: (
        contents: string,
        language: string,
        uri: { toString: () => string },
      ) => {
        const model = {
          uri: uri.toString(),
          contents,
          language,
          dispose: vi.fn(() => models.delete(uri.toString())),
        };
        models.set(uri.toString(), model);
        return model;
      },
    },
    languages: {
      typescript: {
        typescriptDefaults: defaults(),
        javascriptDefaults: defaults(),
        JsxEmit: { React: 2 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        ScriptTarget: { ESNext: 99 },
      },
    },
  };

  return { monaco: monaco as unknown as Monaco, models, compilerOptions, diagnosticsOptions };
}

afterEach(() => {
  clearProjectSources();
});

describe("installProjectSources", () => {
  it("creates a model per source file", () => {
    const { monaco, models } = fakeMonaco();

    const added = installProjectSources(monaco, [
      { relPath: "src/App.tsx", contents: "export const App = 1;" },
      { relPath: "src/util.ts", contents: "export const one = 1;" },
    ]);

    expect(added).toBe(2);
    expect(models.size).toBe(2);
  });

  it("uses the same URI shape an open tab would", () => {
    const { monaco, models } = fakeMonaco();
    installProjectSources(monaco, [{ relPath: "src/App.tsx", contents: "" }]);

    // A file that later opens must find THIS model; Monaco refuses a second
    // model for one URI.
    expect([...models.keys()]).toEqual(["inmemory:///src/App.tsx"]);
  });

  it("does not overwrite a model an open tab already owns", () => {
    const { monaco, models } = fakeMonaco();
    monaco.editor.createModel(
      "the unsaved version",
      "typescript",
      monaco.Uri.from({ scheme: "inmemory", path: "/src/App.tsx" }),
    );

    const added = installProjectSources(monaco, [
      { relPath: "src/App.tsx", contents: "the version on disk" },
    ]);

    expect(added).toBe(0);
    expect(models.get("inmemory:///src/App.tsx")?.contents).toBe(
      "the unsaved version",
    );
  });

  it("picks a language per extension", () => {
    const { monaco, models } = fakeMonaco();
    installProjectSources(monaco, [
      { relPath: "a.tsx", contents: "" },
      { relPath: "b.ts", contents: "" },
      { relPath: "c.jsx", contents: "" },
      { relPath: "d.js", contents: "" },
    ]);

    const language = (name: string) => models.get(`inmemory:///${name}`)?.language;

    expect(language("a.tsx")).toBe("typescript");
    expect(language("b.ts")).toBe("typescript");
    expect(language("c.jsx")).toBe("javascript");
    expect(language("d.js")).toBe("javascript");
  });

  it("enables JSX and node resolution, without which none of this resolves", () => {
    const { monaco, compilerOptions } = fakeMonaco();
    installProjectSources(monaco, []);

    const options = compilerOptions[0];
    expect(options?.["jsx"]).toBe(2);
    expect(options?.["moduleResolution"]).toBe(2);
    expect(options?.["allowJs"]).toBe(true);
    // Existing options are kept rather than replaced wholesale.
    expect(options?.["strict"]).toBe(true);
  });

  it("does not underline other people's files in red", () => {
    const { monaco, diagnosticsOptions } = fakeMonaco();
    installProjectSources(monaco, []);

    expect(diagnosticsOptions[0]?.["noSemanticValidation"]).toBe(true);
  });

  it("adds nothing twice when called again", () => {
    const { monaco } = fakeMonaco();
    const files = [{ relPath: "src/App.tsx", contents: "" }];

    expect(installProjectSources(monaco, files)).toBe(1);
    expect(installProjectSources(monaco, files)).toBe(0);
  });
});

describe("clearProjectSources", () => {
  it("disposes the background models", () => {
    const { monaco, models } = fakeMonaco();
    installProjectSources(monaco, [
      { relPath: "src/App.tsx", contents: "" },
      { relPath: "src/util.ts", contents: "" },
    ]);

    clearProjectSources();

    expect(models.size).toBe(0);
  });

  it("leaves a model an open tab owns alone", () => {
    const { monaco, models } = fakeMonaco();
    monaco.editor.createModel(
      "open",
      "typescript",
      monaco.Uri.from({ scheme: "inmemory", path: "/src/App.tsx" }),
    );
    installProjectSources(monaco, [{ relPath: "src/util.ts", contents: "" }]);

    clearProjectSources();

    // The tab's model survives; only the background one goes.
    expect([...models.keys()]).toEqual(["inmemory:///src/App.tsx"]);
  });
});
