import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeUnwantedModels,
  resetTrackedModels,
  trackModel,
  type TrackedModel,
} from "./editorModels.ts";

/** Stands in for a Monaco model: a URI and a dispose, which is all the sweep
 *  ever touches. */
function model(uri: string): TrackedModel & { dispose: ReturnType<typeof vi.fn> } {
  return { uri: { toString: () => uri }, dispose: vi.fn() };
}

const fileUri = (relPath: string) => `inmemory:///${relPath}`;

beforeEach(() => {
  resetTrackedModels();
});

describe("disposeUnwantedModels", () => {
  it("disposes a model for a file that was closed", () => {
    const closed = model(fileUri("a.ts"));
    trackModel(closed);

    expect(disposeUnwantedModels([])).toBe(1);
    expect(closed.dispose).toHaveBeenCalledOnce();
  });

  it("keeps models for files that are still open", () => {
    const open = model(fileUri("a.ts"));
    const closed = model(fileUri("b.ts"));
    trackModel(open);
    trackModel(closed);

    disposeUnwantedModels([fileUri("a.ts")]);

    expect(open.dispose).not.toHaveBeenCalled();
    expect(closed.dispose).toHaveBeenCalledOnce();
  });

  it("disposes each model once, however often the sweep runs", () => {
    const closed = model(fileUri("a.ts"));
    trackModel(closed);

    disposeUnwantedModels([]);
    disposeUnwantedModels([]);

    expect(closed.dispose).toHaveBeenCalledOnce();
  });

  it("treats tracking the same URI twice as one model", () => {
    // Both panes open the same file: the second finds the model rather than
    // creating one, and tracks what it found.
    const shared = model(fileUri("a.ts"));
    trackModel(shared);
    trackModel(shared);

    expect(disposeUnwantedModels([])).toBe(1);
  });
});

/** The crash this module exists to prevent.
 *
 *  The sweep used to walk `monaco.editor.getModels()` — the page-wide registry
 *  — and dispose everything that was not an open file. The diff editor creates
 *  two models of its own with generated URIs, so every file opened disposed
 *  them; the wrapper's language effect then destructured a null `getModel()`
 *  and took the whole editor pane down with "Cannot destructure property
 *  'original' of ... as it is null".
 */
describe("models this editor did not create", () => {
  it("leaves the diff editor's models alone", () => {
    const original = model("inmemory://model/1");
    const modified = model("inmemory://model/2");
    const ourFile = model(fileUri("a.ts"));
    trackModel(ourFile);

    // Opening a second file: only a.ts is still wanted, and the diff editor's
    // models are not in the wanted list either — nor are they ours.
    disposeUnwantedModels([fileUri("a.ts")]);

    expect(original.dispose).not.toHaveBeenCalled();
    expect(modified.dispose).not.toHaveBeenCalled();
  });

  it("never disposes anything it was not handed", () => {
    const stranger = model("file:///somebody/elses/model.ts");

    expect(disposeUnwantedModels([])).toBe(0);
    expect(stranger.dispose).not.toHaveBeenCalled();
  });
});
