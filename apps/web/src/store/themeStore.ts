import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the user chose. "system" follows the OS, which is the honest default:
 *  someone whose machine is in light mode did not ask for a dark IDE. */
export type ThemeChoice = "system" | "light" | "dark";
/** What that resolves to right now. */
export type ThemeMode = "light" | "dark";

interface ThemeStore {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  /** Forced by the page rather than chosen by the user, and it wins.
   *
   *  An embed is themed by the article that frames it: its `?theme=` parameter
   *  is the host author saying what looks right beside their own text, and a
   *  preference this reader happened to save on this platform months ago is not
   *  a better answer than that. Null everywhere else.
   */
  override: ThemeMode | null;
  setOverride: (mode: ThemeMode | null) => void;
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      choice: "system",
      setChoice: (choice) => {
        set({ choice });
      },
      override: null,
      setOverride: (override) => {
        set({ override });
      },
    }),
    {
      name: "rc-theme",
      // The override belongs to the URL, not to the user, so it must not
      // outlive the page that set it.
      partialize: (state) => ({ choice: state.choice }),
    },
  ),
);

/** What the OS is asking for. */
export function systemMode(): ThemeMode {
  // Guarded: jsdom has `matchMedia` only when a test installs one.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function resolveMode(choice: ThemeChoice): ThemeMode {
  return choice === "system" ? systemMode() : choice;
}
