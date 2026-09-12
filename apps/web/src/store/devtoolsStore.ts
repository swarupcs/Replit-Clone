import { create } from "zustand";
import type {
  BridgeRecord,
  ConsoleRecord,
  ErrorRecord,
  NetworkRecord,
} from "@replit-clone/shared";

/** What the preview has said about itself. plan.md §13.5.
 *
 *  **Bounded, and that is the design rather than a precaution.** The records
 *  come from code this panel does not control — a `console.log` inside
 *  `requestAnimationFrame` is sixty a second forever, and it is a completely
 *  ordinary thing to write by accident. An unbounded store here is a memory
 *  leak with a scrollbar. The bridge rate-limits at the source; these caps are
 *  the half that holds when the source is ignoring them.
 */

/** Kept per feed rather than one shared budget: a chatty log must not push the
 *  errors — the rows somebody actually needs — out of the list. */
export const MAX_CONSOLE = 500;
export const MAX_NETWORK = 300;
export const MAX_ERRORS = 100;

export interface DevtoolsState {
  console: ConsoleRecord[];
  network: NetworkRecord[];
  errors: ErrorRecord[];

  /** Records dropped because a cap was reached, so the panel can say "showing
   *  the last 500 of 12,000" rather than quietly lying about what happened. */
  dropped: number;

  record: (record: BridgeRecord) => void;
  clear: () => void;
  /** A reload means the previous page's console is somebody else's history. */
  clearForReload: () => void;
}

/** Appends and trims in one step, returning the count dropped. */
function push<T>(list: T[], item: T, cap: number): { next: T[]; dropped: number } {
  const next = [...list, item];
  if (next.length <= cap) return { next, dropped: 0 };
  return { next: next.slice(next.length - cap), dropped: next.length - cap };
}

export const useDevtoolsStore = create<DevtoolsState>((set) => ({
  console: [],
  network: [],
  errors: [],
  dropped: 0,

  record: (record) =>
    set((state) => {
      if (record.kind === "console") {
        const { next, dropped } = push(state.console, record, MAX_CONSOLE);
        return { console: next, dropped: state.dropped + dropped };
      }
      if (record.kind === "network") {
        const { next, dropped } = push(state.network, record, MAX_NETWORK);
        return { network: next, dropped: state.dropped + dropped };
      }
      const { next, dropped } = push(state.errors, record, MAX_ERRORS);
      return { errors: next, dropped: state.dropped + dropped };
    }),

  clear: () => set({ console: [], network: [], errors: [], dropped: 0 }),
  clearForReload: () => set({ console: [], network: [], errors: [], dropped: 0 }),
}));

/** The count on the tab, and what turns the overlay on. */
export const selectErrorCount = (state: DevtoolsState): number => state.errors.length;

/** The most recent error, which is the one an overlay should be about. */
export const selectLatestError = (state: DevtoolsState): ErrorRecord | undefined =>
  state.errors[state.errors.length - 1];
