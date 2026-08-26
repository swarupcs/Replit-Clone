import type { Problem } from "../store/problemsStore.ts";

/** Monaco's marker severities. Numbers rather than an enum import, because
 *  this module is deliberately not typed against monaco — see below. */
const ERROR = 8;
const WARNING = 4;
const INFO = 2;

/** The shape of a Monaco marker, narrowed to what a problem needs.
 *
 *  Structural rather than imported, for the same reason `editorModels.ts`
 *  narrows a model: it keeps the mapping testable without loading Monaco, and
 *  the mapping is the part with rules in it.
 */
export interface RawMarker {
  resource: { path: string };
  message: string;
  severity: number;
  startLineNumber: number;
  startColumn: number;
  source?: string;
  owner?: string;
}

function severityOf(severity: number): Problem["severity"] | null {
  if (severity === ERROR) return "error";
  if (severity === WARNING) return "warning";
  if (severity === INFO) return "info";
  // Hints are editor affordances — "this import is unused, click to remove" —
  // not things a Problems list should carry.
  return null;
}

/** Worst first, then by file, then by position: a list you read top-down and
 *  fix in order. */
const RANK: Record<Problem["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Turns Monaco's markers into problems, dropping the ones a list should not
 *  carry and putting the rest in the order they should be read. */
export function toProblems(markers: readonly RawMarker[]): Problem[] {
  const problems: Problem[] = [];

  for (const marker of markers) {
    const severity = severityOf(marker.severity);
    if (!severity) continue;

    // Models are keyed by an inmemory URI whose path is the relPath with a
    // leading slash — see `modelUri` in EditorComponent and `projectSources`.
    const relPath = marker.resource.path.replace(/^\//, "");
    // The diff editor makes models of its own with generated URIs
    // (`inmemory://model/1`); a marker on one of those belongs to no file the
    // user could open.
    if (!relPath || relPath.startsWith("model/")) continue;

    problems.push({
      relPath,
      line: marker.startLineNumber,
      column: marker.startColumn,
      message: marker.message,
      severity,
      source: marker.source,
    });
  }

  return problems.sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      a.relPath.localeCompare(b.relPath) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

/** The part of monaco this needs, so the installer can be handed a stand-in. */
export interface MarkerSource {
  editor: {
    onDidChangeMarkers: (listener: () => void) => { dispose: () => void };
    getModelMarkers: (filter: Record<string, never>) => readonly RawMarker[];
  };
}

/** Keeps `publish` fed with the current problems for as long as the returned
 *  disposer is not called.
 *
 *  Monaco recomputes markers per model and announces which resources changed;
 *  the whole set is re-read rather than patched, because a marker's absence is
 *  as meaningful as its presence and there is no "removed" event to hang that
 *  on.
 */
export function installProblems(
  monaco: MarkerSource,
  publish: (problems: Problem[]) => void,
): () => void {
  const read = () => {
    publish(toProblems(monaco.editor.getModelMarkers({})));
  };

  const subscription = monaco.editor.onDidChangeMarkers(read);
  // Markers for models that already exist have been computed already, and
  // there will be no event for them.
  read();

  return () => {
    subscription.dispose();
  };
}
