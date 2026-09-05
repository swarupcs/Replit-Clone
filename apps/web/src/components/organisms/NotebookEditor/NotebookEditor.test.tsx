// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KernelServerMessage, Notebook } from "@replit-clone/shared";
import { parseNotebook, stringifyNotebook } from "@replit-clone/shared";
import type { KernelState } from "../../../lib/kernelClient.ts";

/** The notebook editor, driven by a fake kernel.
 *
 *  `useKernel` is mocked rather than the WebSocket, and the seam is chosen on
 *  purpose: what these tests are about is the document — what happens to a
 *  cell's outputs, its counter and the saved file when a kernel says a thing.
 *  Faking the socket instead would test `KernelClient`'s buffering twice and
 *  the document not at all.
 */

const execute = vi.fn();
const interrupt = vi.fn();
const restart = vi.fn();

/** The component's own message handler, captured so a test can play the
 *  kernel: `emit({ type: "output", ... })` is a kernel saying something. */
let emit: (message: KernelServerMessage) => void = () => undefined;
let kernelState: KernelState = "idle";
let kernelError: string | null = null;

vi.mock("../../../hooks/useKernel.ts", () => ({
  useKernel: (options: { onMessage: (m: KernelServerMessage) => void }) => {
    emit = options.onMessage;
    return {
      state: kernelState,
      error: kernelError,
      execute,
      interrupt,
      restart,
    };
  },
}));

const { NotebookEditor } = await import("./NotebookEditor.tsx");

function notebookFile(cells: unknown[]): string {
  return JSON.stringify({
    cells,
    metadata: { kernelspec: { language: "python", name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

/** nbformat spells a stream output's text `text`; the in-memory type calls it
 *  `source`. Fixtures here stand for FILE contents, so they use the file's
 *  spelling -- writing `source` produces a cell whose output parses as empty,
 *  which is exactly what the first draft of these tests did. */
function fileStream(text: string) {
  return { output_type: "stream", name: "stdout", text };
}

/** What the KERNEL sends for a stream output, which is nbformat's spelling
 *  again -- `text`. Every emit below uses this rather than hand-writing the
 *  in-memory shape, because hand-writing it is precisely how the wire defect
 *  survived: the tests agreed with the bug. */
function wireStream(text: string) {
  return { output_type: "stream", name: "stdout", text };
}

function code(id: string, source: string, extra: object = {}) {
  return {
    id,
    cell_type: "code",
    source,
    outputs: [],
    execution_count: null,
    metadata: {},
    ...extra,
  };
}

const TWO_CELLS = notebookFile([
  code("a", "print('one')"),
  code("b", "print('two')"),
]);

function show(value: string, canEdit = true) {
  const onChange = vi.fn();
  const view = render(
    <NotebookEditor
      projectId="11111111-1111-4111-8111-111111111111"
      value={value}
      canEdit={canEdit}
      onChange={onChange}
    />,
  );
  return { ...view, onChange };
}

/** The document as the component last saved it. */
function saved(onChange: ReturnType<typeof vi.fn>): Notebook {
  const calls = onChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return parseNotebook(calls[calls.length - 1]![0] as string);
}

beforeEach(() => {
  execute.mockReset();
  interrupt.mockReset();
  restart.mockReset();
  kernelState = "idle";
  kernelError = null;
});

afterEach(cleanup);

describe("opening a notebook", () => {
  it("shows the cells as cells rather than as the JSON they are stored in", () => {
    show(TWO_CELLS);

    expect(screen.getByDisplayValue("print('one')")).toBeTruthy();
    expect(screen.getByDisplayValue("print('two')")).toBeTruthy();
  });

  it("renders a markdown cell rather than showing its source", () => {
    show(notebookFile([{ ...code("m", "# Method"), cell_type: "markdown" }]));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Method");
  });

  /** Opening a file must not write to it. Anything else means opening a
   *  notebook to read it marks it dirty and queues a save. */
  it("saves nothing merely by being opened", () => {
    const { onChange } = show(TWO_CELLS);

    expect(onChange).not.toHaveBeenCalled();
  });

  /** A kernel starts a process and holds memory for as long as the tab is
   *  open, so it is started by Run and not by opening the document. */
  it("asks for no execution until something is run", () => {
    show(TWO_CELLS);

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("a file that is not a notebook this can read", () => {
  it("says so, and says the file has not been touched", () => {
    const { onChange } = show('{"nbformat": 3, "cells": []}');

    expect(screen.getByRole("alert").textContent).toContain("nbformat 3");
    expect(screen.getByText(/has not been changed/i)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  /** The one that matters: a notebook this cannot parse is one it cannot
   *  write back either, so an editor that opened it anyway would be one
   *  Ctrl+S away from replacing the file with a partial read of it. */
  it("offers no way to edit it", () => {
    show("not json at all");

    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("running a cell", () => {
  it("sends the cell's source under the cell's own id", () => {
    show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    expect(execute).toHaveBeenCalledWith("a", "print('one')");
  });

  it("runs on Ctrl+Enter, which is where a notebook user's fingers are", () => {
    show(TWO_CELLS);

    fireEvent.keyDown(screen.getByDisplayValue("print('one')"), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(execute).toHaveBeenCalledWith("a", "print('one')");
  });

  /** Enter alone has to stay a newline, or a notebook cannot be typed into. */
  it("does not run on Enter alone", () => {
    show(TWO_CELLS);

    fireEvent.keyDown(screen.getByDisplayValue("print('one')"), { key: "Enter" });

    expect(execute).not.toHaveBeenCalled();
  });

  /** Asking the kernel would still cost a round trip and bump the counter. */
  it("does not send an empty cell", () => {
    show(notebookFile([code("a", "   \n")]));

    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    expect(execute).not.toHaveBeenCalled();
  });

  it("shows the prompt as running, then as the kernel's own counter", () => {
    show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    expect(screen.getByText("In [*]")).toBeTruthy();

    act(() => {
      emit({ type: "count", cellId: "a", count: 4 });
      emit({ type: "done", cellId: "a", ok: true });
    });

    expect(screen.getByText("In [4]")).toBeTruthy();
  });

  it("renders output as the kernel produces it", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    act(() => {
      emit({
        type: "output",
        cellId: "a",
        output: wireStream("one\n"),
      });
    });

    expect(screen.getByLabelText("Cell output").textContent).toContain("one");
  });

  /** THE regression test in this file, and it is not hypothetical.
   *
   *  These are the exact bytes `rc-kernel` sent when it was run for real
   *  against a built `sandbox-python` image. nbformat spells a stream
   *  output's text `text`; the in-memory type calls it `source`; the gateway
   *  forwards the driver verbatim. So every `print()` in a live notebook
   *  rendered as an empty box, and nothing failed -- `KernelServerMessage`
   *  had simply declared the shape it wanted rather than the one it got.
   *
   *  Every other test here builds its outputs from the in-memory type and so
   *  agreed with the bug. Only running the thing found it. */
  it("renders a stream output in the shape the kernel actually sends", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    act(() => {
      emit({
        type: "output",
        cellId: "a",
        // nbformat's own spelling: `text`, not `source`.
        output: wireStream("42\n"),
      });
    });

    expect(screen.getByLabelText("Cell output").textContent).toContain("42");
  });

  /** The same reader, so the traceback the real kernel produced -- which
   *  arrives wrapped in IPython's terminal colours -- reads as words. */
  it("renders a real error output without its escapes", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    act(() => {
      emit({
        type: "output",
        cellId: "a",
        output: {
          output_type: "error",
          ename: "ZeroDivisionError",
          evalue: "division by zero",
          traceback: [
            "\u001B[31mZeroDivisionError\u001B[39m: division by zero",
          ],
        },
      });
    });

    const text = screen.getByLabelText("Cell output").textContent ?? "";
    expect(text).toContain("ZeroDivisionError: division by zero");
    expect(text).not.toContain("[31m");
  });

  /** An output kind nbformat has and this does not. Dropped rather than
   *  pushed in as a null the renderer would draw an empty box for. */
  it("ignores an output kind it cannot read", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    act(() => {
      emit({ type: "output", cellId: "a", output: { output_type: "update_display_data" } });
    });

    expect(screen.queryByLabelText("Cell output")).toBeNull();
  });

  /** Outputs from the previous run sitting under a cell that is running again
   *  is the most confusing state a notebook can be in, because they look like
   *  this run's. */
  it("clears the last run's output before the new one starts", () => {
    show(
      notebookFile([
        code("a", "print('one')", {
          execution_count: 2,
          outputs: [fileStream("stale\n")],
        }),
      ]),
    );
    expect(screen.getByLabelText("Cell output").textContent).toContain("stale");

    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    expect(screen.queryByLabelText("Cell output")).toBeNull();
  });
});

describe("saving what a run produced", () => {
  /** A cell printing in a loop produces hundreds of stream messages. Saving on
   *  each would queue hundreds of whole-file writes for one execution. */
  it("does not save on every streamed line", () => {
    const { onChange } = show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    onChange.mockClear();

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        emit({
          type: "output",
          cellId: "a",
          output: wireStream(`${index}\n`),
        });
      }
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves once, with everything the cell produced, when it finishes", () => {
    const { onChange } = show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    onChange.mockClear();

    act(() => {
      emit({
        type: "output",
        cellId: "a",
        output: wireStream("one\n"),
      });
      emit({ type: "count", cellId: "a", count: 1 });
      emit({ type: "done", cellId: "a", ok: true });
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const document = saved(onChange);
    expect(document.cells[0]!.execution_count).toBe(1);
    expect(document.cells[0]!.outputs).toHaveLength(1);
  });
});

describe("running the whole notebook", () => {
  it("runs the cells one at a time, in order", () => {
    show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: /run all/i }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith("a", "print('one')");

    act(() => {
      emit({ type: "done", cellId: "a", ok: true });
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith("b", "print('two')");
  });

  /** What Jupyter does, and what anybody watching would want: the cells after
   *  a failure were written expecting this one to have worked. */
  it("stops at the first cell that fails", () => {
    show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: /run all/i }));
    act(() => {
      emit({ type: "done", cellId: "a", ok: false });
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips the empty cells rather than sending them", () => {
    show(notebookFile([code("a", ""), code("b", "x = 1")]));

    fireEvent.click(screen.getByRole("button", { name: /run all/i }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("b", "x = 1");
  });
});

describe("a kernel that goes away", () => {
  /** Leaving the spinner would say a cell is still running something that no
   *  longer exists. */
  it("stops saying a cell is running when the kernel dies", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    expect(screen.getByText("In [*]")).toBeTruthy();

    act(() => {
      emit({ type: "fatal", message: "The kernel stopped." });
    });

    expect(screen.queryByText("In [*]")).toBeNull();
  });

  it("abandons the rest of a Run All", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: /run all/i }));

    act(() => {
      emit({ type: "fatal", message: "The kernel stopped." });
    });
    // Nothing should pick the queue back up: a `done` for the cell that was
    // running when the kernel died must not start the next one.
    act(() => {
      emit({ type: "done", cellId: "a", ok: true });
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("shows the gateway's own refusal rather than a spinner", () => {
    kernelState = "failed";
    kernelError = "This platform only runs Python.";
    show(TWO_CELLS);

    expect(screen.getByRole("alert").textContent).toContain("only runs Python");
  });
});

describe("the kernel controls", () => {
  /** Interrupting an idle kernel is a no-op that looks like it did something. */
  it("offers Interrupt only while something is running", () => {
    show(TWO_CELLS);
    const button = screen.getByRole("button", { name: /interrupt/i });
    expect(button).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));
    expect(button).toHaveProperty("disabled", false);

    fireEvent.click(button);
    expect(interrupt).toHaveBeenCalled();
  });

  /** Told, not dropped. A kernel that is merely disconnected leaves the
   *  process holding its memory, which is what restarting is meant to free. */
  it("tells the kernel to restart, and stops waiting on the running cell", () => {
    show(TWO_CELLS);
    fireEvent.click(screen.getByRole("button", { name: "Run cell 1" }));

    fireEvent.click(screen.getByRole("button", { name: /restart/i }));

    expect(restart).toHaveBeenCalled();
    expect(screen.queryByText("In [*]")).toBeNull();
  });

  /** The control that makes a notebook honest before it is committed: these
   *  results came from a version of the code that no longer exists. */
  it("clears every counter and output, and saves that", () => {
    const { onChange } = show(
      notebookFile([
        code("a", "x = 1", {
          execution_count: 9,
          outputs: [fileStream("old\n")],
        }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: /clear outputs/i }));

    const document = saved(onChange);
    expect(document.cells[0]!.outputs).toHaveLength(0);
    expect(document.cells[0]!.execution_count).toBeNull();
  });
});

describe("editing the document", () => {
  it("saves an edited cell as a notebook, not as whatever was typed", () => {
    const { onChange } = show(TWO_CELLS);

    fireEvent.change(screen.getByDisplayValue("print('one')"), {
      target: { value: "print('edited')" },
    });

    expect(saved(onChange).cells[0]!.source).toBe("print('edited')");
  });

  it("adds a cell below the one asked", () => {
    const { onChange } = show(TWO_CELLS);

    fireEvent.click(
      screen.getByRole("button", { name: "Add a cell below cell 1" }),
    );

    const document = saved(onChange);
    expect(document.cells).toHaveLength(3);
    expect(document.cells[1]!.source).toBe("");
  });

  it("moves a cell, and the document says so", () => {
    const { onChange } = show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: "Move cell 2 up" }));

    expect(saved(onChange).cells.map((cell) => cell.id)).toEqual(["b", "a"]);
  });

  it("deletes a cell", () => {
    const { onChange } = show(TWO_CELLS);

    fireEvent.click(screen.getByRole("button", { name: "Delete cell 1" }));

    expect(saved(onChange).cells.map((cell) => cell.id)).toEqual(["b"]);
  });

  /** Every add button belongs to a cell, so a notebook with none could never
   *  be added to again. */
  it("refuses to delete the last cell", () => {
    show(notebookFile([code("a", "x = 1")]));

    expect(screen.getByRole("button", { name: "Delete cell 1" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  /** nbformat forbids outputs anywhere but a code cell, and a file carrying
   *  them elsewhere fails validation in tools that check it. */
  it("drops the outputs when a code cell becomes markdown", () => {
    const { onChange } = show(
      notebookFile([
        code("a", "x = 1", {
          execution_count: 3,
          outputs: [fileStream("hi\n")],
        }),
      ]),
    );

    fireEvent.change(screen.getByLabelText("Type of cell 1"), {
      target: { value: "markdown" },
    });

    const document = saved(onChange);
    expect(document.cells[0]!.cell_type).toBe("markdown");
    expect(document.cells[0]!.outputs).toHaveLength(0);
    expect(document.cells[0]!.execution_count).toBeNull();
  });

  /** The assertion above passes even without the guard, because BOTH
   *  `stringifyNotebook` and `parseNotebook` drop outputs from a non-code cell
   *  -- so the file is correct either way and the saved document cannot show
   *  the difference. Found by mutation-testing.
   *
   *  What the guard actually protects is the document in memory: without it,
   *  switching a cell to markdown and back brings the old run's outputs and
   *  counter back, attached to code that may since have changed. That is
   *  visible on screen, so this asserts on the screen. */
  it("does not bring back the outputs when a cell returns to code", () => {
    show(
      notebookFile([
        code("a", "x = 1", {
          execution_count: 3,
          outputs: [fileStream("hi\n")],
        }),
      ]),
    );
    expect(screen.getByLabelText("Cell output").textContent).toContain("hi");

    const type = screen.getByLabelText("Type of cell 1");
    fireEvent.change(type, { target: { value: "markdown" } });
    fireEvent.change(type, { target: { value: "code" } });

    expect(screen.queryByLabelText("Cell output")).toBeNull();
    expect(screen.getByText("In [ ]")).toBeTruthy();
  });

  it("opens a markdown cell for editing on a double click, and renders it again", () => {
    show(notebookFile([{ ...code("m", "# Method"), cell_type: "markdown" }]));

    fireEvent.doubleClick(screen.getByRole("button", { name: /Markdown cell 1/ }));
    const input = screen.getByDisplayValue("# Method");

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  /** The one thing this component must never do to somebody's file: write a
   *  shape Jupyter would not have written. */
  it("writes the file back in nbformat's own layout", () => {
    const { onChange } = show(TWO_CELLS);

    fireEvent.change(screen.getByDisplayValue("print('one')"), {
      target: { value: "a\nb\n" },
    });

    const text = onChange.mock.calls[0]![0] as string;
    const raw = JSON.parse(text) as { cells: { source: string[] }[] };
    // One array element per line, each keeping its own newline -- so a change
    // to one cell is a diff of that cell rather than of the whole file.
    expect(raw.cells[0]!.source).toEqual(["a\n", "b\n"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  /** A round trip must not quietly delete a field this version has never
   *  heard of, or opening somebody's notebook and touching one cell would
   *  strip metadata from all of it. */
  it("keeps fields it does not understand", () => {
    const { onChange } = show(
      notebookFile([code("a", "x = 1", { attachments: { "img.png": {} } })]),
    );

    fireEvent.change(screen.getByDisplayValue("x = 1"), {
      target: { value: "x = 2" },
    });

    const raw = JSON.parse(onChange.mock.calls[0]![0] as string) as {
      cells: Record<string, unknown>[];
    };
    expect(raw.cells[0]!["attachments"]).toEqual({ "img.png": {} });
  });
});

describe("a notebook opened by somebody who cannot edit it", () => {
  it("does not offer to run or change anything", () => {
    show(TWO_CELLS, false);

    expect(screen.getByRole("button", { name: "Run cell 1" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /run all/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByDisplayValue("print('one')").hasAttribute("readonly"),
    ).toBe(true);
  });

  it("still shows the document and its saved outputs", () => {
    show(
      notebookFile([
        code("a", "x = 1", {
          outputs: [fileStream("kept\n")],
        }),
      ]),
      false,
    );

    expect(screen.getByLabelText("Cell output").textContent).toContain("kept");
  });
});

describe("what a round trip does to an untouched file", () => {
  /** The claim `stringifyNotebook` makes: a notebook saved here and one saved
   *  by Jupyter are byte-identical where their content is. Asserted through
   *  the component, because the component is what decides when to write. */
  it("re-serialises to exactly what it parsed", () => {
    const original = stringifyNotebook(parseNotebook(TWO_CELLS));
    const { onChange } = show(original);

    fireEvent.click(
      screen.getByRole("button", { name: "Add a cell below cell 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete cell 3" }));

    expect(onChange.mock.calls[1]![0]).toBe(original);
  });
});
