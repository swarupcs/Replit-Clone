import { create } from "zustand";
import { fileExtension } from "@replit-clone/shared";

export interface OpenTab {
  /** POSIX path relative to the project root; unique per tab. */
  relPath: string;
  name: string;
  extension: string | undefined;
  /** Latest known contents. Monaco holds its own model per tab, so this is
   *  only the value the editor is seeded with. */
  value: string;
  /** True when the debounced write has not landed yet. */
  isDirty: boolean;
}

/** The editor can show two files side by side. Tabs are shared; only which
 *  file each pane displays differs. */
export type PaneId = "primary" | "secondary";

interface OpenTabsStore {
  tabs: OpenTab[];
  /** The focused pane's active file. Kept as its own field because almost
   *  everything — the breadcrumb, the status bar, Ctrl+S — means "the file the
   *  user is looking at", not "some pane's file". */
  activeRelPath: string | null;
  /** What the second pane shows, when it is open. */
  secondaryRelPath: string | null;
  /** Whether the second pane is showing at all. */
  splitOpen: boolean;
  /** Which pane new files open into, and which one `activeRelPath` tracks. */
  focusedPane: PaneId;
  /** Where to put the cursor once a file finishes opening.
   *
   *  Opening is asynchronous — the contents arrive over the socket — so a
   *  search result cannot jump to its line at click time. It leaves the
   *  position here and the editor consumes it on arrival. */
  pendingReveal: { relPath: string; line: number; column: number } | null;
  /** A change the assistant has offered, being reviewed in the editor.
   *
   *  Kept here rather than in the chat store because it is the EDITOR that
   *  shows it: the panel can be closed, the pane can be switched away and back,
   *  and the offer outlives both. One at a time — a second review would need a
   *  second diff pane, and the first is the one being read. */
  review: FileReview | null;
  openTab: (relPath: string, value: string) => void;
  closeTab: (relPath: string) => void;
  setActive: (relPath: string) => void;
  markDirty: (relPath: string, isDirty: boolean) => void;
  /** Applies an external change (rename or delete) coming from the tree. */
  renameTab: (relPath: string, newRelPath: string) => void;
  closeAll: () => void;
  /** Opens a file in the other pane, opening the split if it is closed. */
  openToSide: (relPath: string) => void;
  closeSplit: () => void;
  focusPane: (pane: PaneId) => void;
  requestReveal: (relPath: string, line: number, column: number) => void;
  consumeReveal: () => { relPath: string; line: number; column: number } | null;
  /** Shows a proposed change against the file, and focuses it. */
  startReview: (review: FileReview) => void;
  /** Closes the diff, whether it was accepted or discarded. */
  endReview: () => void;
}

/** A proposed replacement for one file, waiting to be read. */
export interface FileReview {
  /** The proposal this came from, so accepting it resolves the right card. */
  id: string;
  relPath: string;
  /** One line on what it changes, shown above the diff. */
  summary: string;
  /** The file as it would be. The left-hand side of the diff is the buffer,
   *  read from Monaco at render time — not a copy taken when the offer was
   *  made, which would hide anything typed since. */
  contents: string;
}

function baseName(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

export const useOpenTabsStore = create<OpenTabsStore>((set, get) => ({
  tabs: [],
  activeRelPath: null,
  secondaryRelPath: null,
  splitOpen: false,
  focusedPane: "primary",
  pendingReveal: null,
  review: null,

  openTab: (relPath, value) => {
    const existing = get().tabs.find((tab) => tab.relPath === relPath);

    /** Which pane a newly opened file lands in. */
    const target = (state: OpenTabsStore) =>
      state.focusedPane === "secondary" && state.splitOpen
        ? { secondaryRelPath: relPath }
        : { activeRelPath: relPath };

    if (existing) {
      // Re-opening a file refreshes its contents but keeps its tab position.
      set((state) => ({
        ...target(state),
        tabs: state.tabs.map((tab) =>
          tab.relPath === relPath ? { ...tab, value, isDirty: false } : tab,
        ),
      }));
      return;
    }

    const name = baseName(relPath);
    set((state) => ({
      ...target(state),
      tabs: [
        ...state.tabs,
        { relPath, name, extension: fileExtension(name), value, isDirty: false },
      ],
    }));
  },

  closeTab: (relPath) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.relPath === relPath);
      const tabs = state.tabs.filter((tab) => tab.relPath !== relPath);

      // Focus the neighbour on the left, matching every editor's behaviour.
      const next = tabs[Math.max(0, index - 1)]?.relPath ?? null;

      // Both panes have to be checked: the same file can be showing in each,
      // and a pane left pointing at a closed tab renders nothing at all.
      return {
        tabs,
        // A review of a file that is no longer open has nothing to compare
        // against, and its diff would render against an empty buffer.
        review: state.review?.relPath === relPath ? null : state.review,
        activeRelPath: state.activeRelPath === relPath ? next : state.activeRelPath,
        secondaryRelPath:
          state.secondaryRelPath === relPath ? next : state.secondaryRelPath,
      };
    }),

  setActive: (relPath) =>
    set((state) =>
      state.focusedPane === "secondary" && state.splitOpen
        ? { secondaryRelPath: relPath }
        : { activeRelPath: relPath },
    ),

  openToSide: (relPath) =>
    set((state) => ({
      splitOpen: true,
      focusedPane: "secondary",
      // If the split is already open showing this file, this is a no-op that
      // simply moves focus there.
      secondaryRelPath: relPath,
      // Seed the primary if nothing is in it, so an empty pane is not left
      // beside the new one.
      activeRelPath: state.activeRelPath ?? relPath,
    })),

  closeSplit: () =>
    set({ splitOpen: false, secondaryRelPath: null, focusedPane: "primary" }),

  focusPane: (pane) => set({ focusedPane: pane }),

  markDirty: (relPath, isDirty) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.relPath === relPath ? { ...tab, isDirty } : tab,
      ),
    })),

  renameTab: (relPath, newRelPath) =>
    set((state) => {
      const name = baseName(newRelPath);
      return {
        tabs: state.tabs.map((tab) =>
          tab.relPath === relPath
            ? { ...tab, relPath: newRelPath, name, extension: fileExtension(name) }
            : tab,
        ),
        activeRelPath:
          state.activeRelPath === relPath ? newRelPath : state.activeRelPath,
        secondaryRelPath:
          state.secondaryRelPath === relPath ? newRelPath : state.secondaryRelPath,
      };
    }),

  closeAll: () =>
    set({
      tabs: [],
      activeRelPath: null,
      secondaryRelPath: null,
      splitOpen: false,
      focusedPane: "primary",
      pendingReveal: null,
      review: null,
    }),

  requestReveal: (relPath, line, column) =>
    set({ pendingReveal: { relPath, line, column } }),

  consumeReveal: () => {
    const pending = get().pendingReveal;
    if (pending) set({ pendingReveal: null });
    return pending;
  },

  startReview: (review) =>
    set({
      review,
      // Into the primary pane deliberately: the reviewer needs to see the file
      // the change is against, and the focused pane may be showing another.
      activeRelPath: review.relPath,
      focusedPane: "primary",
    }),

  endReview: () => set({ review: null }),
}));

/** The currently focused tab, or null. */
export const selectActiveTab = (state: OpenTabsStore): OpenTab | null =>
  state.tabs.find((tab) => tab.relPath === state.activeRelPath) ?? null;

/** The tab a given pane is showing. */
export const selectPaneTab =
  (pane: PaneId) =>
  (state: OpenTabsStore): OpenTab | null => {
    const relPath =
      pane === "secondary" ? state.secondaryRelPath : state.activeRelPath;
    return state.tabs.find((tab) => tab.relPath === relPath) ?? null;
  };

/** True while any open file has edits that have not reached the server. */
export const selectHasUnsavedWork = (state: OpenTabsStore): boolean =>
  state.tabs.some((tab) => tab.isDirty);
