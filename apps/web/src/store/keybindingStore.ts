import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Chord } from "../lib/keybindings.ts";

interface KeybindingStore {
  /** Only what the user changed. Storing the whole resolved set would freeze
   *  today's defaults into their profile, so a later change to a default
   *  they never touched would never reach them. */
  overrides: Record<string, Chord>;
  bind: (commandId: string, chord: Chord) => void;
  reset: (commandId: string) => void;
  resetAll: () => void;
}

export const useKeybindingStore = create<KeybindingStore>()(
  persist(
    (set) => ({
      overrides: {},
      bind: (commandId, chord) =>
        set((state) => ({ overrides: { ...state.overrides, [commandId]: chord } })),
      reset: (commandId) =>
        set((state) => {
          const { [commandId]: _dropped, ...rest } = state.overrides;
          return { overrides: rest };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: "rc-keybindings",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ overrides: state.overrides }),
    },
  ),
);

/** The overrides alone — a stable reference, so a subscriber does not
 *  re-render on every unrelated store change.
 *
 *  Deliberately NOT a selector returning the resolved bindings: that builds a
 *  fresh object on every call, `Object.is` sees a change every time, and the
 *  component renders forever. The same trap `selectProblemCounts` fell into.
 *  Callers subscribe to this and derive with `useMemo`. */
export const selectOverrides = (state: KeybindingStore): Record<string, Chord> =>
  state.overrides;
