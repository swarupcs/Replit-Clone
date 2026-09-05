/** The `.ipynb` document format, and the vocabulary a kernel speaks about it.
 *
 *  plan.md §12.3. Before this, `notebook` and `ipynb` appeared nowhere in
 *  `apps/` or `packages/`: a notebook opened here as a wall of JSON with a
 *  base64 PNG in the middle of it.
 *
 *  Listed in §12 rather than §10 because it is not editor parity — a notebook
 *  is a document format with an execution model attached, and the execution
 *  model is a process in the project's container, which is §12's subject and
 *  not Monaco's.
 *
 *  **Why this is in `shared` and not in the web app.** The format is the
 *  contract between three things that would otherwise each guess at it: the
 *  renderer, the kernel gateway's message vocabulary, and anything later that
 *  wants to read a notebook server-side (search, an outline, a diff). One
 *  authority, tested once.
 */

/** nbformat's three cell kinds. `raw` is passed through untouched — it exists
 *  for nbconvert and means nothing to a kernel. */
export type NotebookCellType = "code" | "markdown" | "raw";

/** A MIME bundle: one representation per media type, which is how a single
 *  result can be a PNG for a person and a `text/plain` repr for a diff. */
export type MimeBundle = Record<string, unknown>;

export interface StreamOutput {
  output_type: "stream";
  /** `stdout` or `stderr`. Kept as the file's own string rather than a union:
   *  a kernel may invent a stream name, and dropping the output would be worse
   *  than rendering an unfamiliar one. */
  name: string;
  source: string;
}

export interface DisplayOutput {
  output_type: "display_data" | "execute_result";
  data: MimeBundle;
  metadata: Record<string, unknown>;
  /** Present on `execute_result` only, and nbformat requires it there. */
  execution_count?: number | null;
}

export interface ErrorOutput {
  output_type: "error";
  ename: string;
  evalue: string;
  /** ANSI-coloured lines, as the kernel produced them. */
  traceback: string[];
}

export type NotebookOutput = StreamOutput | DisplayOutput | ErrorOutput;

export interface NotebookCell {
  /** Stable for the life of the document, and nbformat 4.5's own field.
   *  Synthesised for a 4.0–4.4 notebook that has none, because a renderer
   *  needs a key and "the index" is the key that reorders wrongly. */
  id: string;
  cell_type: NotebookCellType;
  /** One string, newlines and all. The file stores an array of lines and
   *  `stringifyNotebook` puts it back that way — see the note there. */
  source: string;
  outputs: NotebookOutput[];
  execution_count: number | null;
  metadata: Record<string, unknown>;
  /** Everything else the file had on this cell, kept so a round trip does not
   *  quietly delete a field this version has never heard of. */
  extra: Record<string, unknown>;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
  extra: Record<string, unknown>;
}

/** A file that is not a notebook, or is one this cannot honour. */
export class NotebookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookFormatError";
  }
}

/** nbformat 4 is the only version anything has written since 2015. A 3 is
 *  refused rather than half-read: its cells live as `input`/`prompt_number`
 *  under a `worksheets` array, and reading it as a 4 would silently produce an
 *  empty notebook to save over the top of somebody's file. */
export const SUPPORTED_NBFORMAT = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** nbformat stores text as an array of lines, each keeping its own trailing
 *  newline, or as one string. Both are legal and both are common. */
function joinSource(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === "string" ? line : "")).join("");
  }
  return "";
}

/** The inverse, and it is not cosmetic. Jupyter writes one array element per
 *  line, so a notebook where a single cell changed is a diff of that cell's
 *  lines. Writing `source` back as one string would make every save a
 *  whole-file rewrite in git, on a format people already complain about
 *  diffing badly. */
export function splitSource(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    // A trailing newline ends the previous element; it does not add an empty
    // one. `"a\n"` is `["a\n"]`, which is what Jupyter writes.
    if (last && line === "") continue;
    out.push(last ? line : `${line}\n`);
  }
  return out;
}

let synthesised = 0;

/** nbformat 4.5 cell ids are `[a-zA-Z0-9-_]{1,64}`. */
function cellId(raw: unknown): string {
  if (typeof raw === "string" && /^[a-zA-Z0-9\-_]{1,64}$/.test(raw)) return raw;
  synthesised += 1;
  return `rc-${String(synthesised)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One nbformat output object, as written in a file or as sent by a kernel.
 *
 *  Exported, and the reason is a defect this caught. nbformat spells a stream
 *  output's text `text`; the in-memory type above calls it `source`, because
 *  `source` is what every other text-bearing thing here is called. That
 *  translation lived inside `parseNotebook` and so applied only to text read
 *  from a FILE.
 *
 *  The kernel gateway forwards the driver's messages verbatim, and the driver
 *  emits nbformat -- so a live `print()` arrived as `{ text: "42
" }`, was
 *  rendered as `output.source`, and drew an empty box. Typecheck could not see
 *  it: the wire is JSON, and `KernelServerMessage` simply asserted the shape it
 *  wished for. So the wire type now says `unknown` and everything crossing it
 *  comes through here. */
export function parseOutput(raw: unknown): NotebookOutput | null {
  return readOutput(raw);
}

function readOutput(raw: unknown): NotebookOutput | null {
  if (!isRecord(raw)) return null;
  const type = raw["output_type"];

  if (type === "stream") {
    return {
      output_type: "stream",
      name: typeof raw["name"] === "string" ? raw["name"] : "stdout",
      source: joinSource(raw["text"]),
    };
  }

  if (type === "execute_result" || type === "display_data") {
    return {
      output_type: type,
      data: isRecord(raw["data"]) ? raw["data"] : {},
      metadata: isRecord(raw["metadata"]) ? raw["metadata"] : {},
      execution_count:
        typeof raw["execution_count"] === "number"
          ? raw["execution_count"]
          : null,
    };
  }

  if (type === "error") {
    return {
      output_type: "error",
      ename: typeof raw["ename"] === "string" ? raw["ename"] : "Error",
      evalue: typeof raw["evalue"] === "string" ? raw["evalue"] : "",
      traceback: Array.isArray(raw["traceback"])
        ? raw["traceback"].map((line) =>
            typeof line === "string" ? line : JSON.stringify(line),
          )
        : [],
    };
  }

  // An output kind nbformat has and this does not. Dropped rather than
  // rendered — and dropping it is why a notebook is only written back when
  // the user has actually edited it.
  return null;
}

const CELL_KNOWN = new Set([
  "id",
  "cell_type",
  "source",
  "outputs",
  "execution_count",
  "metadata",
]);

const NOTEBOOK_KNOWN = new Set([
  "cells",
  "metadata",
  "nbformat",
  "nbformat_minor",
]);

function rest(
  raw: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

export function parseNotebook(text: string): Notebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NotebookFormatError("This file is not valid JSON.");
  }

  if (!isRecord(raw)) {
    throw new NotebookFormatError("A notebook has to be a JSON object.");
  }

  const nbformat = raw["nbformat"];
  if (typeof nbformat !== "number") {
    throw new NotebookFormatError(
      'This file has no "nbformat" field, so it is not a notebook.',
    );
  }
  if (nbformat !== SUPPORTED_NBFORMAT) {
    // Named in both directions: what it is and what would read it. Silently
    // reading a 3 as a 4 yields an empty notebook, and saving that would
    // overwrite the file with nothing.
    throw new NotebookFormatError(
      `This is an nbformat ${String(nbformat)} notebook and this editor reads ` +
        `${String(SUPPORTED_NBFORMAT)}. Open it in Jupyter once to convert it.`,
    );
  }

  const cells = Array.isArray(raw["cells"]) ? raw["cells"] : [];

  return {
    cells: cells.filter(isRecord).map((cell) => {
      const type = cell["cell_type"];
      const cellType: NotebookCellType =
        type === "code" || type === "markdown" || type === "raw" ? type : "raw";

      return {
        id: cellId(cell["id"]),
        cell_type: cellType,
        source: joinSource(cell["source"]),
        // Only code cells carry outputs; nbformat forbids them elsewhere, and
        // a markdown cell that somehow had them would fail validation on the
        // way back out.
        outputs:
          cellType === "code" && Array.isArray(cell["outputs"])
            ? cell["outputs"]
                .map(readOutput)
                .filter((output): output is NotebookOutput => output !== null)
            : [],
        execution_count:
          typeof cell["execution_count"] === "number"
            ? cell["execution_count"]
            : null,
        metadata: isRecord(cell["metadata"]) ? cell["metadata"] : {},
        extra: rest(cell, CELL_KNOWN),
      };
    }),
    metadata: isRecord(raw["metadata"]) ? raw["metadata"] : {},
    nbformat,
    nbformat_minor:
      typeof raw["nbformat_minor"] === "number" ? raw["nbformat_minor"] : 5,
    extra: rest(raw, NOTEBOOK_KNOWN),
  };
}

function writeOutput(output: NotebookOutput): Record<string, unknown> {
  if (output.output_type === "stream") {
    return {
      output_type: "stream",
      name: output.name,
      text: splitSource(output.source),
    };
  }
  if (output.output_type === "error") {
    return {
      output_type: "error",
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback,
    };
  }
  const written: Record<string, unknown> = {
    output_type: output.output_type,
    data: output.data,
    metadata: output.metadata,
  };
  // Required on execute_result by the schema, absent on display_data.
  if (output.output_type === "execute_result") {
    written["execution_count"] = output.execution_count ?? null;
  }
  return written;
}

/** JSON with one-space indent and sorted keys, and a trailing newline.
 *
 *  **Those three details are the whole reason this is a function rather than
 *  `JSON.stringify`.** `nbformat.write` uses exactly them, so a notebook saved
 *  here and one saved by Jupyter are byte-identical where their content is.
 *  A two-space indent would make the first save from this editor a diff
 *  touching every line of somebody's notebook — on a format people already
 *  complain about diffing badly, which is the sort of thing that gets a tool
 *  taken back out of a team's workflow.
 */
function toJupyterJson(value: unknown): string {
  const sortDeep = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortDeep);
    if (isRecord(input)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        sorted[key] = sortDeep(input[key]);
      }
      return sorted;
    }
    return input;
  };

  return `${JSON.stringify(sortDeep(value), null, 1)}\n`;
}

export function stringifyNotebook(notebook: Notebook): string {
  return toJupyterJson({
    ...notebook.extra,
    cells: notebook.cells.map((cell) => {
      const written: Record<string, unknown> = {
        ...cell.extra,
        cell_type: cell.cell_type,
        metadata: cell.metadata,
        source: splitSource(cell.source),
      };

      // 4.5 added cell ids; writing one into a 4.4 file makes it fail
      // validation in tools that check the schema strictly.
      if (notebook.nbformat_minor >= 5) written["id"] = cell.id;

      if (cell.cell_type === "code") {
        written["execution_count"] = cell.execution_count;
        written["outputs"] = cell.outputs.map(writeOutput);
      }

      return written;
    }),
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
  });
}

/** True for a path this editor should open as a notebook. */
export function isNotebookPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".ipynb");
}

export function emptyCell(cellType: NotebookCellType): NotebookCell {
  return {
    id: cellId(undefined),
    cell_type: cellType,
    source: "",
    outputs: [],
    execution_count: null,
    metadata: {},
    extra: {},
  };
}

/** A new notebook, in the shape Jupyter would have written. */
export function emptyNotebook(): Notebook {
  return {
    cells: [emptyCell("code")],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    extra: {},
  };
}

/** What the kernel gateway sends the browser, and what the browser sends back.
 *
 *  A deliberate narrowing of Jupyter's own message spec down to what a
 *  renderer needs. The full spec has five sockets, HMAC signing and thirty
 *  message types; all of that lives inside the container, in the driver that
 *  speaks to the kernel. What crosses the WebSocket is this.
 */
export type KernelServerMessage =
  /** The kernel is up and ready for its first execute. */
  | { type: "ready"; kernel: string; language: string }
  /** Busy/idle, so a cell can show that it is actually running. */
  | { type: "status"; state: "busy" | "idle" | "starting" }
  /** One output for one cell, in the order the kernel produced it.
   *
   *  A RAW nbformat output object, not a `NotebookOutput`: it is JSON off a
   *  socket, written by a Python process, and this type cannot make it true by
   *  declaring it. Put it through `parseOutput` -- which is the same reader a
   *  file goes through, so the two paths cannot drift again. */
  | { type: "output"; cellId: string; output: unknown }
  /** The execution counter the kernel assigned, which is the `In [n]`. */
  | { type: "count"; cellId: string; count: number }
  /** That cell is finished. `ok` is false for an error or an interrupt. */
  | { type: "done"; cellId: string; ok: boolean }
  /** The kernel died, or never started. */
  | { type: "fatal"; message: string };

export type KernelClientMessage =
  | { type: "execute"; cellId: string; code: string }
  | { type: "interrupt" }
  | { type: "restart" };
