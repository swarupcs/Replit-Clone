import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import dracula from "../theme/dracula.json";
import alucard from "../theme/alucard.json";

/** The editor came up white inside a dark IDE, and no test noticed.
 *
 *  None could have. The bug was in the ORDER two real Monaco calls happened in:
 *  @monaco-editor/react runs `setTheme("dracula")` immediately after
 *  `editor.create(...)`, while the theme was being defined in `onMount`, which
 *  fires afterwards. Monaco fell back to its built-in `vs`, and nothing ever
 *  corrected it because the library only reapplies a theme when the prop
 *  CHANGES. Reproducing that needs workers, layout and a real canvas, so every
 *  suite that renders an editor mocks Monaco away — and `monaco-editor` cannot
 *  even be imported here, which is why this reads the source instead.
 *
 *  Source-level assertions are a poor way to test behaviour and a good way to
 *  hold a fix in place. What they pin down is exactly what broke: where the
 *  themes are registered, and that nothing asks for a name by hand.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const setup = read("./monacoSetup.ts");
const names = read("./editorThemes.ts");

describe("where the themes are registered", () => {
  it("registers both, at module load rather than inside anything", () => {
    // Not indented, so not in a function, so it has already run by the time any
    // component can create an editor. That is the entire fix.
    const topLevel = setup
      .split("\n")
      .filter((line) => line.startsWith("monaco.editor.defineTheme("));

    expect(topLevel).toHaveLength(2);
  });

  it("registers exactly the two names the app asks for", () => {
    // The names live apart from the registration so that importing them does
    // not drag Monaco in; this is what keeps the two halves agreeing.
    expect(names).toContain(
      'export const EDITOR_THEMES = { dark: "dracula", light: "alucard" }',
    );
    expect(setup).toContain("EDITOR_THEMES.dark");
    expect(setup).toContain("EDITOR_THEMES.light");
  });

  it("pairs each name with a theme of the right polarity", () => {
    // Names alone would pass if the two were swapped, which is the same white
    // editor by another route.
    expect(dracula.base).toBe("vs-dark");
    expect(alucard.base).toBe("vs");
  });
});

describe("every editor in the app", () => {
  /** Monaco's `vs` and `vs-dark` are the fallback the bug landed on, so a
   *  component naming one is that failure written down deliberately. */
  const SOURCES = [
    "../components/molecules/EditorComponent/EditorComponent.tsx",
    "../components/organisms/DatabasePanel/DatabasePanel.tsx",
    "../components/organisms/DatabasePanel/MongoWorkbench.tsx",
    "../pages/EmbedPage.tsx",
  ];

  it.each(SOURCES)("takes its theme from the shared names: %s", (relative) => {
    const source = read(relative);

    expect(source).toContain("EDITOR_THEMES");
    expect(source).not.toMatch(/theme=\{?["']vs(-dark)?["']/);
    expect(source).not.toMatch(/["'](alucard|dracula)["']/);
  });

  it.each(SOURCES)("defines no theme of its own: %s", (relative) => {
    // One registration site. A second is how the two fall out of step.
    expect(read(relative)).not.toContain("defineTheme(");
  });
});
