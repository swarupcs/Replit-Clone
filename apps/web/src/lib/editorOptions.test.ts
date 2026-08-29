import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEditorOptions, RULER_COLUMNS } from "./editorOptions.ts";
import {
  useEditorSettingsStore,
  type EditorSettings,
} from "../store/editorSettingsStore.ts";

const defaults = (): EditorSettings => {
  const { set: _set, reset: _reset, ...settings } = useEditorSettingsStore.getState();
  return settings;
};

const optionsWith = (overrides: Partial<EditorSettings> = {}) =>
  buildEditorOptions({ ...defaults(), ...overrides }, { canEdit: true });

describe("buildEditorOptions", () => {
  /** Every option the settings dialog exposes, as a list rather than as
   *  prose.
   *
   *  Each of these is an option Monaco already implements and the editor
   *  simply never switched on, so the failure mode being guarded against is
   *  one of them silently going missing in a later edit to the options
   *  object. */
  it.each([
    "bracketPairColorization",
    "stickyScroll",
    "inlayHints",
    "linkedEditing",
    "occurrencesHighlight",
    "renderWhitespace",
    "inlineSuggest",
    "suggest",
    "formatOnPaste",
    "formatOnType",
    "unicodeHighlight",
    "rulers",
    "cursorSurroundingLines",
  ])("sets %s", (key) => {
    expect(optionsWith()).toHaveProperty(key);
  });

  it("turns on bracket colouring, sticky scroll, inlay hints and ghost text by default", () => {
    const options = optionsWith();
    expect(options.bracketPairColorization).toEqual({ enabled: true });
    expect(options.stickyScroll).toEqual({ enabled: true });
    expect(options.inlayHints).toEqual({ enabled: "on" });
    expect(options.inlineSuggest).toEqual({ enabled: true });
    expect(options.suggest).toEqual({ preview: true });
  });

  it("leaves both format triggers off by default, as format-on-save is", () => {
    const options = optionsWith();
    expect(options.formatOnPaste).toBe(false);
    expect(options.formatOnType).toBe(false);
  });

  it("draws whitespace inside a selection by default", () => {
    expect(optionsWith().renderWhitespace).toBe("selection");
  });

  it("follows each preference rather than hardcoding it", () => {
    expect(optionsWith({ stickyScroll: false }).stickyScroll).toEqual({
      enabled: false,
    });
    expect(optionsWith({ inlayHints: false }).inlayHints).toEqual({ enabled: "off" });
    expect(optionsWith({ bracketPairColorization: false }).bracketPairColorization).toEqual(
      { enabled: false },
    );
    expect(optionsWith({ renderWhitespace: "all" }).renderWhitespace).toBe("all");
    expect(optionsWith({ formatOnPaste: true }).formatOnPaste).toBe(true);
    expect(optionsWith({ cursorSurroundingLines: 8 }).cursorSurroundingLines).toBe(8);
  });

  it("draws the column guides only when they are asked for", () => {
    expect(optionsWith({ rulers: false }).rulers).toEqual([]);
    expect(optionsWith({ rulers: true }).rulers).toEqual([...RULER_COLUMNS]);
  });

  /** Linked editing, occurrence highlighting and the homoglyph warnings are
   *  on for everyone. The last is a security affordance — a Cyrillic 'а' in
   *  an identifier is worth flagging whether or not anyone asked. */
  it("keeps the unconditional options on regardless of preferences", () => {
    const off = optionsWith({
      bracketPairColorization: false,
      stickyScroll: false,
      inlayHints: false,
      inlineSuggest: false,
      rulers: false,
    });
    expect(off.linkedEditing).toBe(true);
    expect(off.occurrencesHighlight).toBe("singleFile");
    expect(off.unicodeHighlight).toEqual({
      ambiguousCharacters: true,
      invisibleCharacters: true,
    });
  });

  it("still presents read-only access as read-only", () => {
    expect(buildEditorOptions(defaults(), { canEdit: false }).readOnly).toBe(true);
    expect(buildEditorOptions(defaults(), { canEdit: true }).readOnly).toBe(false);
  });
});

describe("the settings dialog", () => {
  /** A preference nothing can reach is not a preference. The store is the
   *  list of what people are allowed to choose, so it is the store — not the
   *  dialog — that decides what the dialog owes a row. */
  it("offers a control for every preference in the store", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../components/organisms/EditorSettingsDialog/EditorSettingsDialog.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    for (const key of Object.keys(defaults())) {
      expect(source, `no control for the "${key}" preference`).toContain(
        `settings.${key}`,
      );
    }
  });

  /** A preference left out of `partialize` still works for the rest of the
   *  session and then quietly forgets itself on reload, which reads as a bug
   *  in the setting rather than in the store. Adding a preference and
   *  forgetting this line is the easiest version of that mistake to make,
   *  so it is the one worth a guard. */
  it("persists every preference in the store", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../store/editorSettingsStore.ts", import.meta.url)),
      "utf8",
    );
    const partialize = source.slice(source.indexOf("partialize:"));

    for (const key of Object.keys(defaults())) {
      expect(partialize, `"${key}" is not persisted`).toContain(`${key}: state.${key}`);
    }
  });
});
