import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "antd";
import type {
  Notebook,
  NotebookCell,
  NotebookCellType,
} from "@replit-clone/shared";
import {
  NotebookFormatError,
  emptyCell,
  parseNotebook,
  parseOutput,
  stringifyNotebook,
} from "@replit-clone/shared";
import { parseMarkdown } from "../../../lib/notebookMarkdown.ts";
import { promptLabel } from "../../../lib/notebookOutput.ts";
import { useKernel } from "../../../hooks/useKernel.ts";
import { MarkdownBlocks } from "./MarkdownBlocks.tsx";
import { NotebookOutputs } from "./NotebookOutputs.tsx";

/** A notebook, as a document rather than as the JSON it is stored in.
 *
 *  plan.md §12.3. Before this, opening a `.ipynb` here gave you the file: a
 *  wall of JSON with a base64 PNG somewhere in the middle of it.
 *
 *  **Deliberately store-free.** Everything it needs arrives as a prop and
 *  every change leaves as one, so the whole component can be rendered in a
 *  test with a notebook and a fake kernel. `EditorComponent` owns the wiring
 *  to the tab store and the write queue, which is where that wiring already
 *  lives for every other file.
 */

export interface NotebookEditorProps {
  /** For the kernel's container, not for the file. */
  projectId: string;
  /** The file's text, as the server last sent it. */
  value: string;
  /** Read-only for a viewer, and for a file over the size limit. */
  canEdit: boolean;
  /** The document, serialised, whenever it changes. `EditorComponent` debounces
   *  and queues it exactly as it does a Monaco buffer. */
  onChange: (text: string) => void;
}

/** One cell replaced, the rest shared. */
function mapCell(
  notebook: Notebook,
  cellId: string,
  change: (cell: NotebookCell) => NotebookCell,
): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((cell) =>
      cell.id === cellId ? change(cell) : cell,
    ),
  };
}

/** A notebook records its kernel in `metadata.kernelspec.language`. Absent in
 *  plenty of real files -- anything written by a script rather than by Jupyter
 *  -- and Python is the only kernel this platform has, so that is the guess
 *  worth making. The server refuses anything it cannot run, with a message. */
function languageOf(notebook: Notebook): string {
  const spec = notebook.metadata["kernelspec"];
  if (typeof spec === "object" && spec !== null) {
    const language = (spec as { language?: unknown }).language;
    if (typeof language === "string" && language !== "") return language;
  }
  return "python";
}

/** A textarea that is exactly as tall as its content.
 *
 *  Not Monaco, and that is a decision rather than a shortcut. A notebook has
 *  as many editors as it has cells; a hundred Monaco instances in one document
 *  is tens of megabytes of models and a scroll that stutters. What a cell
 *  editor has to do is hold text, grow, and hand back keystrokes — and the
 *  cost of a real editor is paid per cell while the benefit is per keystroke.
 *
 *  What this gives up, stated plainly: syntax highlighting, autocomplete, and
 *  the language server §12.3's own note points at. Worth revisiting if
 *  notebooks turn out to be used for anything longer than a page.
 */
function CellInput({
  value,
  disabled,
  ariaLabel,
  onChange,
  onRun,
  onRunAndAdvance,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange: (text: string) => void;
  onRun: () => void;
  onRunAndAdvance: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Reset first: without it the box only ever grows, because `scrollHeight`
    // of an over-tall textarea is its own height.
    node.style.height = "auto";
    node.style.height = `${String(node.scrollHeight)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="rc-nb-input"
      spellCheck={false}
      aria-label={ariaLabel}
      value={value}
      readOnly={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        // Jupyter's two bindings, and people who use notebooks have them in
        // their fingers. Enter alone must stay a newline.
        if (event.key !== "Enter") return;
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          onRun();
        } else if (event.shiftKey) {
          event.preventDefault();
          onRunAndAdvance();
        }
      }}
    />
  );
}

export function NotebookEditor({
  projectId,
  value,
  canEdit,
  onChange,
}: NotebookEditorProps) {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  /** Markdown cells currently being edited rather than rendered. */
  const [editing, setEditing] = useState<Set<string>>(() => new Set());

  /** The live document, for callbacks that outlive the render they were made
   *  in -- the kernel's message handler, above all. */
  const current = useRef<Notebook | null>(null);
  current.current = notebook;

  /** Set below. The kernel's handler is constructed before `runCell` exists
   *  and outlives the render that made it, so Run All reaches the current one
   *  through here rather than closing over the first. */
  const runCellRef = useRef<((cellId: string) => void) | null>(null);

  /** Cells still to run, for Run All. Jupyter executes serially and so does
   *  the driver, so this advances on `done` rather than sending them all at
   *  once -- which would also make an error impossible to stop at. */
  const queue = useRef<string[]>([]);

  /** Parse when the SERVER's copy changes, and only then.
   *
   *  `OpenTab.value` is set when a file is read and never again, so this seeds
   *  once per open. Parsing on every render would throw away the edit being
   *  typed; parsing on our own writes would throw away the cursor.
   */
  useEffect(() => {
    try {
      setNotebook(parseNotebook(value));
      setParseError(null);
    } catch (error) {
      setNotebook(null);
      setParseError(
        error instanceof NotebookFormatError
          ? error.message
          : "This file could not be read as a notebook.",
      );
    }
    queue.current = [];
    setRunningCellId(null);
  }, [value]);

  /** Applies a change and saves it.
   *
   *  One path, so there is no way to edit the document without persisting it.
   */
  const edit = useCallback(
    (change: (notebook: Notebook) => Notebook) => {
      const previous = current.current;
      if (!previous) return;
      const next = change(previous);
      // The ref first, so two edits in one tick compose rather than the second
      // being computed from the document the first replaced.
      current.current = next;
      setNotebook(next);
      onChange(stringifyNotebook(next));
    },
    [onChange],
  );

  /** Applies a change WITHOUT saving.
   *
   *  For streamed output only, and the distinction earns its keep: a cell that
   *  prints in a loop produces hundreds of `stream` messages, and saving on
   *  each would queue hundreds of whole-file writes for one execution. The
   *  `done` message saves once, which is also when the outputs are actually
   *  worth keeping.
   */
  const touch = useCallback((change: (notebook: Notebook) => Notebook) => {
    const previous = current.current;
    if (!previous) return;
    const next = change(previous);
    current.current = next;
    setNotebook(next);
  }, []);

  const kernel = useKernel({
    projectId,
    language: notebook ? languageOf(notebook) : "python",
    onMessage: (message) => {
      if (message.type === "output") {
        // Through the file reader, because the kernel sends nbformat and
        // nbformat is not quite this app's shape -- a stream's text is `text`
        // there and `source` here. See `parseOutput`.
        const output = parseOutput(message.output);
        // An output kind nbformat has and this does not. Dropped rather than
        // rendered as an empty box, which is what a `null` cell would be.
        if (!output) return;
        touch((nb) =>
          mapCell(nb, message.cellId, (cell) => ({
            ...cell,
            outputs: [...cell.outputs, output],
          })),
        );
        return;
      }

      if (message.type === "count") {
        touch((nb) =>
          mapCell(nb, message.cellId, (cell) => ({
            ...cell,
            execution_count: message.count,
          })),
        );
        return;
      }

      if (message.type === "done") {
        setRunningCellId(null);
        // Saved here, once, with everything the cell produced.
        const document = current.current;
        if (document) onChange(stringifyNotebook(document));

        // Run All stops at the first cell that failed, which is what Jupyter
        // does and what anybody watching would want: the cells after it were
        // written expecting this one to have worked.
        if (!message.ok) {
          queue.current = [];
          return;
        }
        const next = queue.current.shift();
        if (next !== undefined) runCellRef.current?.(next);
        return;
      }

      if (message.type === "fatal") {
        // The kernel died mid-cell. Leaving the spinner would say it is still
        // running something that no longer exists.
        setRunningCellId(null);
        queue.current = [];
      }
    },
  });

  /** Sends one cell, having cleared what it produced last time.
   *
   *  Cleared before rather than after: outputs from the previous run sitting
   *  under a cell that is running again is the most confusing state a notebook
   *  can be in, because they look like this run's.
   */
  const runCell = useCallback(
    (cellId: string) => {
      const document = current.current;
      const cell = document?.cells.find((entry) => entry.id === cellId);
      if (!document || !cell || cell.cell_type !== "code") return;
      // Nothing to run, and asking the kernel would still cost a round trip
      // and bump the execution counter.
      if (cell.source.trim() === "") return;

      setRunningCellId(cellId);
      touch((nb) =>
        mapCell(nb, cellId, (entry) => ({
          ...entry,
          outputs: [],
          execution_count: null,
        })),
      );
      kernel.execute(cellId, cell.source);
    },
    [kernel, touch],
  );

  runCellRef.current = runCell;

  const runAll = useCallback(() => {
    const document = current.current;
    if (!document) return;
    const ids = document.cells
      .filter((cell) => cell.cell_type === "code" && cell.source.trim() !== "")
      .map((cell) => cell.id);
    if (ids.length === 0) return;

    queue.current = ids.slice(1);
    runCell(ids[0]!);
  }, [runCell]);

  const restart = useCallback(() => {
    queue.current = [];
    setRunningCellId(null);
    kernel.restart();
  }, [kernel]);

  /** Every code cell's counter back to `In [ ]`.
   *
   *  Its own control because "restart" and "restart and clear" answer different
   *  questions: the first is "this kernel is wedged", the second is "these
   *  results are from a version of the code that no longer exists". The second
   *  is the one that makes a notebook honest before it is committed.
   */
  const clearOutputs = useCallback(() => {
    edit((nb) => ({
      ...nb,
      cells: nb.cells.map((cell) =>
        cell.cell_type === "code"
          ? { ...cell, outputs: [], execution_count: null }
          : cell,
      ),
    }));
  }, [edit]);

  const busy = runningCellId !== null;

  const status = useMemo(() => {
    if (kernel.state === "failed") return kernel.error ?? "The kernel stopped.";
    if (kernel.state === "idle") return "No kernel running";
    if (kernel.state === "connecting") return "Connecting…";
    if (kernel.state === "starting") return "Starting the kernel…";
    return kernel.state === "busy" ? "Running" : "Ready";
  }, [kernel.state, kernel.error]);

  if (parseError !== null) {
    return (
      <div className="rc-nb-broken" role="alert">
        <strong>This notebook could not be opened.</strong>
        <p>{parseError}</p>
        {/* Deliberately not offering "open it as JSON anyway". A notebook this
            cannot parse is one it also cannot write back, and an editor that
            opened it would be one Ctrl+S away from replacing somebody's file
            with a partial read of it. */}
        <p className="rc-nb-broken-note">
          The file has not been changed. Nothing here will write to it.
        </p>
      </div>
    );
  }

  if (!notebook) return null;

  return (
    <div className="rc-nb">
      <div className="rc-nb-toolbar" role="toolbar" aria-label="Notebook">
        <button type="button" onClick={runAll} disabled={!canEdit || busy}>
          Run all
        </button>
        <button
          type="button"
          onClick={kernel.interrupt}
          // Only while something is running: interrupting an idle kernel is a
          // no-op that looks like it did something.
          disabled={!busy}
        >
          Interrupt
        </button>
        <button type="button" onClick={restart} disabled={!canEdit}>
          Restart
        </button>
        <button type="button" onClick={clearOutputs} disabled={!canEdit || busy}>
          Clear outputs
        </button>

        <span
          className="rc-nb-status"
          data-state={kernel.state}
          // A kernel that failed announces itself; the ordinary busy/idle
          // churn does not, or a screen reader would narrate every cell.
          role={kernel.state === "failed" ? "alert" : undefined}
        >
          {status}
        </span>
      </div>

      <div className="rc-nb-cells">
        {notebook.cells.map((cell, index) => {
          const running = runningCellId === cell.id;
          const isMarkdown = cell.cell_type === "markdown";
          const rendered = isMarkdown && !editing.has(cell.id);

          const setSource = (source: string) => {
            edit((nb) => mapCell(nb, cell.id, (entry) => ({ ...entry, source })));
          };

          const advance = () => {
            runCell(cell.id);
            const next = notebook.cells[index + 1];
            // Jupyter adds a cell when Shift+Enter is pressed on the last one,
            // which is how a notebook is written from the bottom.
            if (!next && canEdit) {
              edit((nb) => ({ ...nb, cells: [...nb.cells, emptyCell("code")] }));
            }
          };

          return (
            <div
              key={cell.id}
              className="rc-nb-cell"
              data-type={cell.cell_type}
              data-running={running || undefined}
            >
              <div className="rc-nb-gutter">
                {cell.cell_type === "code" && (
                  <>
                    <Tooltip title="Run this cell (Ctrl+Enter)">
                      <button
                        type="button"
                        className="rc-nb-run"
                        aria-label={`Run cell ${String(index + 1)}`}
                        onClick={() => runCell(cell.id)}
                        disabled={!canEdit || busy}
                      >
                        ▶
                      </button>
                    </Tooltip>
                    <span className="rc-nb-prompt">
                      {promptLabel(cell.execution_count, running)}
                    </span>
                  </>
                )}
              </div>

              <div className="rc-nb-body">
                {rendered ? (
                  <div
                    className="rc-nb-rendered"
                    role="button"
                    tabIndex={0}
                    aria-label={`Markdown cell ${String(index + 1)}, double-click to edit`}
                    onDoubleClick={() => {
                      if (!canEdit) return;
                      setEditing((set) => new Set(set).add(cell.id));
                    }}
                    onKeyDown={(event) => {
                      if (!canEdit) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setEditing((set) => new Set(set).add(cell.id));
                      }
                    }}
                  >
                    {cell.source.trim() === "" ? (
                      <span className="rc-nb-empty-md">Empty markdown cell</span>
                    ) : (
                      <MarkdownBlocks blocks={parseMarkdown(cell.source)} />
                    )}
                  </div>
                ) : (
                  <CellInput
                    value={cell.source}
                    disabled={!canEdit}
                    ariaLabel={`${cell.cell_type} cell ${String(index + 1)}`}
                    onChange={setSource}
                    onRun={() => {
                      if (isMarkdown) {
                        setEditing((set) => {
                          const next = new Set(set);
                          next.delete(cell.id);
                          return next;
                        });
                        return;
                      }
                      runCell(cell.id);
                    }}
                    onRunAndAdvance={() => {
                      if (isMarkdown) {
                        setEditing((set) => {
                          const next = new Set(set);
                          next.delete(cell.id);
                          return next;
                        });
                        return;
                      }
                      advance();
                    }}
                  />
                )}

                {cell.cell_type === "code" && (
                  <NotebookOutputs outputs={cell.outputs} />
                )}
              </div>

              <div className="rc-nb-actions">
                <select
                  aria-label={`Type of cell ${String(index + 1)}`}
                  value={cell.cell_type}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const type = event.target.value as NotebookCellType;
                    edit((nb) =>
                      mapCell(nb, cell.id, (entry) => ({
                        ...entry,
                        cell_type: type,
                        // nbformat forbids outputs anywhere but a code cell,
                        // and a file carrying them elsewhere fails validation
                        // in tools that check it.
                        outputs: type === "code" ? entry.outputs : [],
                        execution_count:
                          type === "code" ? entry.execution_count : null,
                      })),
                    );
                  }}
                >
                  <option value="code">Code</option>
                  <option value="markdown">Markdown</option>
                  <option value="raw">Raw</option>
                </select>

                <button
                  type="button"
                  aria-label={`Add a cell below cell ${String(index + 1)}`}
                  disabled={!canEdit}
                  onClick={() => {
                    edit((nb) => {
                      const cells = [...nb.cells];
                      cells.splice(index + 1, 0, emptyCell("code"));
                      return { ...nb, cells };
                    });
                  }}
                >
                  +
                </button>

                <button
                  type="button"
                  aria-label={`Move cell ${String(index + 1)} up`}
                  disabled={!canEdit || index === 0}
                  onClick={() => {
                    edit((nb) => {
                      const cells = [...nb.cells];
                      const [moved] = cells.splice(index, 1);
                      cells.splice(index - 1, 0, moved!);
                      return { ...nb, cells };
                    });
                  }}
                >
                  ↑
                </button>

                <button
                  type="button"
                  aria-label={`Move cell ${String(index + 1)} down`}
                  disabled={!canEdit || index === notebook.cells.length - 1}
                  onClick={() => {
                    edit((nb) => {
                      const cells = [...nb.cells];
                      const [moved] = cells.splice(index, 1);
                      cells.splice(index + 1, 0, moved!);
                      return { ...nb, cells };
                    });
                  }}
                >
                  ↓
                </button>

                <button
                  type="button"
                  aria-label={`Delete cell ${String(index + 1)}`}
                  // A notebook with no cells cannot be added to, because every
                  // add button belongs to a cell.
                  disabled={!canEdit || notebook.cells.length === 1}
                  onClick={() => {
                    edit((nb) => ({
                      ...nb,
                      cells: nb.cells.filter((entry) => entry.id !== cell.id),
                    }));
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
