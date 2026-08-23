import { create } from "zustand";
import type { ContainerStats, RunState } from "@replit-clone/shared";

/** Cap on retained log lines. The server bounds its own history, but a
 *  long-lived dev server can emit far more than that over a session. */
const MAX_LINES = 2000;

interface RunStore {
  state: RunState;
  /** Bumped when the dev server starts answering, so the preview pane can
   *  reload itself instead of leaving the user to guess when to. */
  readyNonce: number;
  /** Bumped when the project's files change while the run is live, for the
   *  same reason: the preview reloads rather than waiting on a hot-reload
   *  that a bind mount may never deliver. */
  contentNonce: number;
  /** Latest container stats sample, or null before the first one. */
  stats: ContainerStats | null;
  /** The dev server's answer to the preview's last page request, when it was
   *  an error. Null when healthy or unknown — the pane shows a banner while
   *  set so a compile failure is never mistaken for an ignored save. */
  previewError: number | null;
  /** Raw chunks, not lines: the terminal renderer handles splitting, and
   *  splitting here would break escape sequences spanning a chunk boundary. */
  output: string[];
  setState: (state: RunState) => void;
  markPreviewReady: () => void;
  markPreviewContentChanged: () => void;
  setPreviewError: (status: number | null) => void;
  setStats: (stats: ContainerStats) => void;
  appendOutput: (chunk: string) => void;
  replaceOutput: (chunks: string[]) => void;
  reset: () => void;
}

const initialState: RunState = { status: "idle" };

export const useRunStore = create<RunStore>((set) => ({
  state: initialState,
  output: [],
  readyNonce: 0,
  contentNonce: 0,
  stats: null,
  previewError: null,

  setState: (state) => set({ state }),

  markPreviewReady: () =>
    set((current) => ({
      readyNonce: current.readyNonce + 1,
      // A restart is a fresh dev server: whatever was broken before is not
      // the state of what is coming up now.
      previewError: null,
    })),

  markPreviewContentChanged: () =>
    set((current) => ({ contentNonce: current.contentNonce + 1 })),

  setPreviewError: (status) => set({ previewError: status }),

  setStats: (stats) => set({ stats }),

  appendOutput: (chunk) =>
    set((current) => {
      const next = [...current.output, chunk];
      return { output: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next };
    }),

  replaceOutput: (chunks) => set({ output: chunks }),

  reset: () =>
    set({
      state: initialState,
      output: [],
      readyNonce: 0,
      contentNonce: 0,
      stats: null,
      previewError: null,
    }),
}));
