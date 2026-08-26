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
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      choice: "system",
      setChoice: (choice) => {
        set({ choice });
      },
    }),
    { name: "rc-theme" },
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
