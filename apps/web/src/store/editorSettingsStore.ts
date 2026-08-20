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
}

const DEFAULTS: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  formatOnSave: false,
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
      }),
    },
  ),
);

export const EDITOR_SETTING_LIMITS = {
  fontSize: { min: 10, max: 24 },
  tabSize: { min: 2, max: 8 },
} as const;
