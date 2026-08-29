import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import dracula from "../theme/dracula.json";
import alucard from "../theme/alucard.json";

/** What is left of the white-editor guard once a real browser checks it.
 *
 *  The bug: the editor came up white inside a dark IDE, because the themes
 *  were defined in `onMount` and @monaco-editor/react calls `setTheme` the
 *  instant after `editor.create(...)`. Reproducing it needs workers, layout
 *  and a real canvas, so this file used to hold the fix in place by reading
 *  its own source with `readFileSync` and asserting on the text — which is a
 *  fair way to stop a specific line moving and no way at all to know what
 *  colour anything is.
 *
 *  **The behaviour is now asserted where it is visible**: `e2e/
 *  playground-flow.spec.ts` opens a real editor and reads the computed
 *  background off `.monaco-editor-background`. That runs in CI on every pull
 *  request, which is what made it safe to delete the source-text assertions
 *  rather than merely regret them.
 *
 *  Two things stay here, both because the browser cannot see them:
 *
 *  - Which polarity each named theme has. The E2E asserts the editor is dark
 *    in dark mode; it does not open the light one.
 *  - That the three editors the E2E never opens have not grown a theme of
 *    their own. A second registration site is how the two fall out of step,
 *    and no run of the flow above would notice.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("the two themes", () => {
  it("pairs each name with a theme of the right polarity", () => {
    // Swapping these is the same white editor by another route, and the pair
    // is data rather than source text — this is a real assertion about the
    // thing that ships, not about how it is written.
    expect(dracula.base).toBe("vs-dark");
    expect(alucard.base).toBe("vs");
  });
});

describe("the editors the browser test never opens", () => {
  /** Monaco's `vs` and `vs-dark` are the fallback the bug landed on, so a
   *  component naming one is that failure written down deliberately. */
  const SOURCES = [
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
