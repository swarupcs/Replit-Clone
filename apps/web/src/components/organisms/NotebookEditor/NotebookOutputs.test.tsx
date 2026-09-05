// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NotebookOutput } from "@replit-clone/shared";
import { NotebookOutputs } from "./NotebookOutputs.tsx";

const ESC = "\u001B";

function show(outputs: NotebookOutput[]) {
  return render(<NotebookOutputs outputs={outputs} />);
}

afterEach(cleanup);

describe("what a cell produced", () => {
  it("shows nothing at all for a cell that produced nothing", () => {
    const { container } = show([]);

    expect(container.innerHTML).toBe("");
  });

  /** Order is the content. A cell that printed, plotted, then raised did those
   *  three things in that sequence, and grouping by kind would misreport it. */
  it("keeps the kernel's own order", () => {
    const { container } = show([
      { output_type: "stream", name: "stdout", source: "first\n" },
      {
        output_type: "execute_result",
        data: { "text/plain": "second" },
        metadata: {},
        execution_count: 1,
      },
    ]);

    expect(container.textContent).toBe("first\nsecond");
  });

  it("renders a PNG as an image with a real alt", () => {
    show([
      {
        output_type: "display_data",
        data: { "image/png": "iVBORw0KGgo=" },
        metadata: {},
      },
    ]);

    const image = screen.getByRole("img");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(image.getAttribute("alt")).toBe("Output image");
  });
});

describe("a cell that failed", () => {
  const ERROR: NotebookOutput = {
    output_type: "error",
    ename: "ZeroDivisionError",
    evalue: "division by zero",
    traceback: [
      `${ESC}[0;31m---------${ESC}[0m`,
      "Cell In[1], line 1",
      `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`,
    ],
  };

  /** A long traceback pushes its own last line off the bottom, and the last
   *  line is the one anybody reads. So the answer is stated before the frames
   *  that lead to it. */
  it("states the error before the frames", () => {
    show([ERROR]);

    expect(screen.getByText("ZeroDivisionError: division by zero")).toBeTruthy();
  });

  it("announces itself, because a failure is worth interrupting for", () => {
    show([ERROR]);

    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("shows the traceback without IPython's terminal colours", () => {
    const { container } = show([ERROR]);

    expect(container.textContent).toContain("Cell In[1], line 1");
    expect(container.textContent).not.toContain(ESC);
    expect(container.textContent).not.toContain("[0;31m");
  });

  /** A kernel that died before producing frames is a real case, and an empty
   *  `<pre>` under the headline would look like something failed to load. */
  it("renders without a traceback when there is none", () => {
    const { container } = show([
      { output_type: "error", ename: "KeyboardInterrupt", evalue: "", traceback: [] },
    ]);

    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("KeyboardInterrupt");
  });
});

describe("stderr, which is not a failure", () => {
  /** tqdm, logging and every deprecation warning write here. Marking these as
   *  errors would report a cell that ran perfectly well as broken. */
  it("is tinted rather than flagged as an error", () => {
    const { container } = show([
      { output_type: "stream", name: "stderr", source: "FutureWarning: ...\n" },
    ]);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      container.querySelector('[data-stream="stderr"]')?.textContent,
    ).toContain("FutureWarning");
  });
});

describe("an output this editor does not render", () => {
  /** Named rather than dropped: an empty box under a cell that clearly did
   *  something reads as a bug in the editor. */
  it("says what the output was", () => {
    const { container } = show([
      {
        output_type: "display_data",
        data: { "application/vnd.plotly.v1+json": {} },
        metadata: {},
      },
    ]);

    expect(container.textContent).toContain("application/vnd.plotly.v1+json");
  });

  /** The security decision, at the level a person can see it: a DataFrame's
   *  HTML is never put into the page, and the plain text beside it is. */
  it("shows a DataFrame's text and never injects its HTML", () => {
    const { container } = show([
      {
        output_type: "execute_result",
        data: {
          "text/html": "<table><tr><td>1</td></tr></table>",
          "text/plain": "   a\n0  1",
        },
        metadata: {},
        execution_count: 3,
      },
    ]);

    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("0  1");
  });
});
