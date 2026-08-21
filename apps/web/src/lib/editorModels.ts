/** Keeps track of the Monaco models the editor itself created.
 *
 *  Monaco's model registry is global and shared by everything on the page, so
 *  `monaco.editor.getModels()` is NOT a list of this component's models. The
 *  diff editor creates two of its own (with generated `inmemory://model/N`
 *  URIs, since it is given contents rather than a path), and the tab sweep used
 *  to walk that global list and dispose everything whose URI was not one of the
 *  open files — which disposed the diff editor's models out from under it.
 *
 *  The wrapper's language effect then does `const { original, modified } =
 *  diffEditor.getModel()` with no null check, so the next file opened in a
 *  different language crashed the whole editor pane with "Cannot destructure
 *  property 'original' of ... as it is null".
 *
 *  Module-level rather than per-component because Monaco's registry is: two
 *  editor panes share one model per file, and it must be disposed once, by
 *  whichever pane sweeps first.
 */
export interface TrackedModel {
  uri: { toString: () => string };
  dispose: () => void;
}

const owned = new Map<string, TrackedModel>();

/** Records a model as ours, and therefore ours to dispose. Idempotent, so it
 *  can be called on every open rather than only on creation — the second pane
 *  to show a file finds the model instead of creating it. */
export function trackModel(model: TrackedModel): void {
  owned.set(model.uri.toString(), model);
}

/** Disposes every tracked model that is no longer wanted.
 *
 *  Only tracked models are considered, so anything Monaco holds on someone
 *  else's behalf is left alone. Returns how many were disposed, which is what
 *  makes the behaviour observable to a test.
 */
export function disposeUnwantedModels(wantedUris: Iterable<string>): number {
  const wanted = new Set(wantedUris);
  let disposed = 0;

  for (const [uri, model] of owned) {
    if (wanted.has(uri)) continue;
    owned.delete(uri);
    model.dispose();
    disposed += 1;
  }

  return disposed;
}

/** Test seam. The registry mirrors Monaco's own global one, which lives for as
 *  long as the page does; a test needs to start from empty. */
export function resetTrackedModels(): void {
  owned.clear();
}
