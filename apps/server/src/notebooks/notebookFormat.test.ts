import { describe, expect, it } from "vitest";
import {
  NotebookFormatError,
  emptyNotebook,
  isNotebookPath,
  parseNotebook,
  splitSource,
  stringifyNotebook,
  type Notebook,
} from "@replit-clone/shared";

/** The `.ipynb` document format. plan.md §12.3.
 *
 *  Tested here rather than in `packages/shared` because that package has no
 *  test runner of its own — the same arrangement `egressPolicy.test.ts` uses
 *  for the egress rules, and for the same reason.
 *
 *  **What is actually at stake in this file is somebody else's git history.**
 *  A notebook is JSON that people commit, review and merge, and a reader that
 *  is merely correct — right cells, right outputs — can still rewrite every
 *  line of the file on the first save. Roughly half the assertions below are
 *  about bytes rather than about meaning, and they are the half that would be
 *  missed.
 */

/** As `nbformat.write` produces it: one-space indent, sorted keys, a trailing
 *  newline, and `source` as an array of lines each keeping its own `\n`. */
const JUPYTER_FILE = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "intro",
   "metadata": {},
   "source": [
    "# Sales\\n",
    "\\n",
    "Read the CSV and plot it."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 3,
   "id": "load",
   "metadata": {},
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "rows: 120\\n"
     ]
    },
    {
     "data": {
      "text/plain": [
       "120"
      ]
     },
     "execution_count": 3,
     "metadata": {},
     "output_type": "execute_result"
    }
   ],
   "source": [
    "import pandas as pd\\n",
    "df = pd.read_csv(\\"sales.csv\\")\\n",
    "print(f\\"rows: {len(df)}\\")\\n",
    "len(df)"
   ]
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "name": "python",
   "version": "3.13.1"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
`;

describe("a notebook Jupyter wrote", () => {
  const notebook = parseNotebook(JUPYTER_FILE);

  it("reads the cells in order, with their kinds", () => {
    expect(notebook.cells.map((cell) => cell.cell_type)).toEqual([
      "markdown",
      "code",
    ]);
  });

  /** The array-of-lines form is the one on disk; a renderer wants one string
   *  and a kernel wants one string. Joined once, here. */
  it("joins the line array back into source", () => {
    expect(notebook.cells[0]?.source).toBe(
      "# Sales\n\nRead the CSV and plot it.",
    );
  });

  it("keeps the execution count that produced the outputs", () => {
    expect(notebook.cells[1]?.execution_count).toBe(3);
  });

  it("reads both output kinds the cell produced", () => {
    expect(notebook.cells[1]?.outputs.map((o) => o.output_type)).toEqual([
      "stream",
      "execute_result",
    ]);
  });

  it("keeps the kernelspec, which is what says how to run it", () => {
    expect(notebook.metadata["kernelspec"]).toMatchObject({ name: "python3" });
  });

  /** **The assertion this whole module exists for.** Byte-for-byte, not
   *  deep-equal: one-space indent, sorted keys, a trailing newline. Opening a
   *  notebook and saving it without touching it must produce no diff at all,
   *  or the first thing this editor does to a repository is rewrite every
   *  notebook in it. */
  it("writes back the identical bytes it read", () => {
    expect(stringifyNotebook(notebook)).toBe(JUPYTER_FILE);
  });
});

describe("the line-splitting that keeps diffs small", () => {
  it("gives every line but the last its own newline", () => {
    expect(splitSource("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
  });

  /** A trailing newline ENDS the last line; it does not add an empty one.
   *  Getting this wrong appends a `""` element that Jupyter would not have
   *  written, which is a diff on every cell that ends in a newline — which is
   *  most of them. */
  it("does not invent an empty last line for trailing newlines", () => {
    expect(splitSource("a\n")).toEqual(["a\n"]);
  });

  it("represents an empty cell as no lines, not one empty line", () => {
    expect(splitSource("")).toEqual([]);
  });
});

describe("what it refuses, and why refusing beats guessing", () => {
  it("refuses a file that is not JSON", () => {
    expect(() => parseNotebook("not json")).toThrow(NotebookFormatError);
  });

  it("refuses JSON that is not a notebook", () => {
    expect(() => parseNotebook('{"name":"pkg"}')).toThrow(/not a notebook/);
  });

  /** nbformat 3 keeps its cells under `worksheets`, so reading it as a 4
   *  finds `cells: undefined` and yields an EMPTY notebook — which would then
   *  be saved over the top of the file. The refusal is the only thing between
   *  an old notebook and losing it. */
  it("refuses nbformat 3 rather than reading it as an empty notebook", () => {
    const three = JSON.stringify({
      nbformat: 3,
      nbformat_minor: 0,
      worksheets: [{ cells: [{ cell_type: "code", input: ["1+1"] }] }],
    });

    expect(() => parseNotebook(three)).toThrow(/nbformat 3 notebook/);
  });
});

describe("fields this version has never heard of", () => {
  /** Widget state, `attachments`, an `nbdime` marker, whatever a future minor
   *  adds. Dropping them is a silent, invisible edit to somebody's file. */
  it("carries an unknown top-level key through a round trip", () => {
    const withExtra = JSON.stringify({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
      unexpected: { kept: true },
    });

    const back: unknown = JSON.parse(
      stringifyNotebook(parseNotebook(withExtra)),
    );
    expect(back).toMatchObject({ unexpected: { kept: true } });
  });

  it("carries an unknown cell key through a round trip", () => {
    const withExtra = JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          id: "a",
          metadata: {},
          source: ["hi"],
          attachments: { "img.png": { "image/png": "AAAA" } },
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });

    const back = JSON.parse(stringifyNotebook(parseNotebook(withExtra))) as {
      cells: { attachments: unknown }[];
    };
    expect(back.cells[0]?.attachments).toEqual({
      "img.png": { "image/png": "AAAA" },
    });
  });
});

describe("the older minors, which are still in real repositories", () => {
  /** Cell ids arrived in 4.5. Writing one into a 4.4 file makes it fail
   *  strict schema validation in tools that check — so the id is synthesised
   *  for the renderer's sake and not written back. */
  it("does not write a cell id into a notebook too old to have them", () => {
    const old: Notebook = {
      ...emptyNotebook(),
      nbformat_minor: 4,
    };

    expect(JSON.parse(stringifyNotebook(old))).toMatchObject({
      cells: [{ cell_type: "code" }],
    });
    expect(stringifyNotebook(old)).not.toContain('"id"');
  });

  it("gives a cell with no id one anyway, so it can be rendered", () => {
    const notebook = parseNotebook(
      JSON.stringify({
        cells: [{ cell_type: "code", source: ["1"], metadata: {} }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 4,
      }),
    );

    expect(notebook.cells[0]?.id).toMatch(/\S/);
  });
});

describe("outputs where nbformat is strict about shape", () => {
  /** `execute_result` requires `execution_count`; `display_data` must not
   *  have one. A single writer for both is how that gets confused. */
  it("writes execution_count on a result and not on a display", () => {
    const notebook = emptyNotebook();
    notebook.cells[0]!.outputs = [
      {
        output_type: "execute_result",
        data: { "text/plain": "2" },
        metadata: {},
        execution_count: 7,
      },
      { output_type: "display_data", data: { "text/plain": "x" }, metadata: {} },
    ];

    const written = JSON.parse(stringifyNotebook(notebook)) as {
      cells: { outputs: Record<string, unknown>[] }[];
    };
    expect(written.cells[0]?.outputs[0]).toHaveProperty("execution_count", 7);
    expect(written.cells[0]?.outputs[1]).not.toHaveProperty("execution_count");
  });

  /** A markdown cell with outputs fails nbformat validation. The file can
   *  contain one; what leaves here cannot. */
  it("drops outputs from a cell that is not code", () => {
    const notebook = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            id: "a",
            metadata: {},
            source: ["hi"],
            outputs: [{ output_type: "stream", name: "stdout", text: ["x"] }],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );

    expect(notebook.cells[0]?.outputs).toEqual([]);
    expect(stringifyNotebook(notebook)).not.toContain("outputs");
  });
});

describe("isNotebookPath", () => {
  it.each([
    ["analysis.ipynb", true],
    ["a/b/Analysis.IPYNB", true],
    ["notebook.py", false],
    ["ipynb", false],
  ])("%s -> %s", (path, expected) => {
    expect(isNotebookPath(path)).toBe(expected);
  });
});
