import { create } from "zustand";
import type { RunState } from "@replit-clone/shared";

/** Cap on retained log lines. The server bounds its own history, but a
 *  long-lived dev server can emit far more than that over a session. */
const MAX_LINES = 2000;

interface RunStore {
  state: RunState;
  /** Raw chunks, not lines: the terminal renderer handles splitting, and
   *  splitting here would break escape sequences spanning a chunk boundary. */
  output: string[];
  setState: (state: RunState) => void;
  appendOutput: (chunk: string) => void;
  replaceOutput: (chunks: string[]) => void;
  reset: () => void;
}

const initialState: RunState = { status: "idle" };

export const useRunStore = create<RunStore>((set) => ({
  state: initialState,
  output: [],

  setState: (state) => set({ state }),

  appendOutput: (chunk) =>
    set((current) => {
      const next = [...current.output, chunk];
      return { output: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next };
    }),

  replaceOutput: (chunks) => set({ output: chunks }),

  reset: () => set({ state: initialState, output: [] }),
}));
