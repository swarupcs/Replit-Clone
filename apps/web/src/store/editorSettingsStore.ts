import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Editor preferences.
 *
 *  Font size, tab width, word wrap and the minimap were hardcoded, so anyone
 *  who found the defaults uncomfortable had no recourse. Persisted to
 *  localStorage because a preference that resets on reload is not a preference.
 */
export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  /** Run Monaco's formatter before each save. Off by default: reformatting a
   *  file someone did not ask to reformat is a rude surprise, and it makes
   *  diffs enormous in a project with no formatter config of its own. */
  formatOnSave: boolean;
  /** Tint nested brackets by depth, as VS Code has by default since 1.67. */
  bracketPairColorization: boolean;
  /** Pin the enclosing class and function above the viewport. Costs viewport
   *  height, which is why it is a preference rather than simply on. */
  stickyScroll: boolean;
  /** Inferred parameter names and types, inline. TypeScript and JavaScript
   *  only until a language server can answer for the rest. */
  inlayHints: boolean;
  /** Ghost text previewing the current completion in place. */
  inlineSuggest: boolean;
  /** Where whitespace is drawn. "selection" is the useful middle: visible
   *  when you are looking at a region, invisible the rest of the time. */
  renderWhitespace: "none" | "selection" | "all";
  /** Format on paste and as you type. Off by default for the same reason
   *  formatOnSave is. */
  formatOnPaste: boolean;
  formatOnType: boolean;
  /** Column guides at 80 and 120. */
  rulers: boolean;
  /** scrolloff: lines kept below the cursor, so the line being typed is
   *  never the last one visible. */
  cursorSurroundingLines: number;
}

const DEFAULTS: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  formatOnSave: false,
  bracketPairColorization: true,
  stickyScroll: true,
  inlayHints: true,
  inlineSuggest: true,
  renderWhitespace: "selection",
  formatOnPaste: false,
  formatOnType: false,
  rulers: false,
  cursorSurroundingLines: 3,
};

interface EditorSettingsStore extends EditorSettings {
  set: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => void;
  reset: () => void;
}

export const useEditorSettingsStore = create<EditorSettingsStore>()(
  persist(
    (setState) => ({
      ...DEFAULTS,
      set: (key, value) => setState({ [key]: value } as Partial<EditorSettings>),
      reset: () => setState(DEFAULTS),
    }),
    {
      name: "rc-editor-settings",
      // Resolved when the store is created rather than when the module
      // loads, so a host that defines localStorage later still gets it.
      storage: createJSONStorage(() => localStorage),
      // Only the preferences; the actions are rebuilt on load.
      partialize: (state) => ({
        fontSize: state.fontSize,
        tabSize: state.tabSize,
        wordWrap: state.wordWrap,
        minimap: state.minimap,
        lineNumbers: state.lineNumbers,
        formatOnSave: state.formatOnSave,
        bracketPairColorization: state.bracketPairColorization,
        stickyScroll: state.stickyScroll,
        inlayHints: state.inlayHints,
        inlineSuggest: state.inlineSuggest,
        renderWhitespace: state.renderWhitespace,
        formatOnPaste: state.formatOnPaste,
        formatOnType: state.formatOnType,
        rulers: state.rulers,


        cursorSurroundingLines: state.cursorSurroundingLines,
      }),
    },
  ),
);

export const EDITOR_SETTING_LIMITS = {
  fontSize: { min: 10, max: 24 },
  tabSize: { min: 2, max: 8 },
  cursorSurroundingLines: { min: 0, max: 20 },
} as const;
