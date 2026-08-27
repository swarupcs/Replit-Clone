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
  /** A preview tab is the one a single click opens, and the next single
   *  click replaces. At most one exists at a time. Browsing a tree without
   *  it leaves thirty tabs behind, which is the complaint this answers. */
  isPreview: boolean;
  /** Pinned tabs sit left of every unpinned one and survive Close Others. */
  isPinned: boolean;
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
  /** Paths in most-recently-used order, newest first.
   *
   *  Ctrl+Tab walks this rather than the strip, which is what VS Code does
   *  and what makes the chord useful: the tab you want next is almost always
   *  the one you were just in, not the one that happens to sit to the right. */
  mru: string[];
  /** Paths of closed tabs, newest last, for Ctrl+Shift+T.
   *
   *  Paths rather than tabs: the contents came from the server and may have
   *  changed since, so reopening re-reads rather than resurrecting a stale
   *  copy. Bounded, because this is an undo affordance and not a history. */
  closed: string[];
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
  /** `preview` opens the tab as a replaceable preview, the way a single
   *  click in the tree does. Anything deliberate — a double click, a search
   *  result, an editor action — opens permanently. */
  openTab: (relPath: string, value: string, options?: { preview?: boolean }) => void;
  closeTab: (relPath: string) => void;
  /** Turns a preview tab into a permanent one. Editing does this too. */
  promoteTab: (relPath: string) => void;
  togglePin: (relPath: string) => void;
  /** Moves a tab to a new index in the strip, keeping pinned tabs left of
   *  unpinned ones however far the drag went. */
  moveTab: (relPath: string, toIndex: number) => void;
  closeOthers: (relPath: string) => void;
  closeToRight: (relPath: string) => void;
  closeSaved: () => void;
  /** Pops the most recently closed path, for Ctrl+Shift+T. The caller
   *  reopens it — the store never held its contents. */
  takeClosed: () => string | null;
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

/** How many closed paths Ctrl+Shift+T can walk back through. */
const CLOSED_LIMIT = 20;

/** Pinned tabs left, unpinned right, each block keeping its own order.
 *
 *  Applied after every reorder rather than enforced inside each one, because
 *  "pinned tabs are on the left" is a property of the strip and not of any
 *  single operation on it. */
function withPinnedFirst(tabs: OpenTab[]): OpenTab[] {
  return [...tabs.filter((tab) => tab.isPinned), ...tabs.filter((tab) => !tab.isPinned)];
}

/** Newest first, and never more than one entry per path. */
function touchMru(mru: string[], relPath: string): string[] {
  return [relPath, ...mru.filter((path) => path !== relPath)];
}

export const useOpenTabsStore = create<OpenTabsStore>((set, get) => ({
  tabs: [],
  activeRelPath: null,
  secondaryRelPath: null,
  splitOpen: false,
  focusedPane: "primary",
  pendingReveal: null,
  review: null,
  mru: [],
  closed: [],

  openTab: (relPath, value, options) => {
    const existing = get().tabs.find((tab) => tab.relPath === relPath);

    /** Which pane a newly opened file lands in. */
    const target = (state: OpenTabsStore) =>
      state.focusedPane === "secondary" && state.splitOpen
        ? { secondaryRelPath: relPath }
        : { activeRelPath: relPath };

    const preview = options?.preview ?? false;

    if (existing) {
      // Re-opening a file refreshes its contents but keeps its tab position.
      // A deliberate open of something already previewing promotes it: the
      // second, intentional visit is what says "I mean to keep this".
      set((state) => ({
        ...target(state),
        mru: touchMru(state.mru, relPath),
        tabs: state.tabs.map((tab) =>
          tab.relPath === relPath
            ? { ...tab, value, isDirty: false, isPreview: tab.isPreview && preview }
            : tab,
        ),
      }));
      return;
    }

    const name = baseName(relPath);
    const opened: OpenTab = {
      relPath,
      name,
      extension: fileExtension(name),
      value,
      isDirty: false,
      isPreview: preview,
      isPinned: false,
    };

    set((state) => {
      // A preview takes the existing preview's place in the strip rather than
      // appending, so clicking down a directory keeps one tab rather than
      // leaving one per file. A dirty preview is never replaced — there is
      // unsaved work in it — and neither is a pinned one, which cannot be a
      // preview anyway.
      const replaceable = preview
        ? state.tabs.findIndex((tab) => tab.isPreview && !tab.isDirty && !tab.isPinned)
        : -1;

      const tabs =
        replaceable === -1
          ? [...state.tabs, opened]
          : state.tabs.map((tab, index) => (index === replaceable ? opened : tab));

      const replaced = replaceable === -1 ? null : state.tabs[replaceable]?.relPath;

      return {
        ...target(state),
        tabs: withPinnedFirst(tabs),
        mru: touchMru(
          replaced ? state.mru.filter((path) => path !== replaced) : state.mru,
          relPath,
        ),
      };
    });
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
        mru: state.mru.filter((path) => path !== relPath),
        closed: [...state.closed, relPath].slice(-CLOSED_LIMIT),
      };
    }),

  promoteTab: (relPath) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.relPath === relPath ? { ...tab, isPreview: false } : tab,
      ),
    })),

  togglePin: (relPath) =>
    set((state) => ({
      tabs: withPinnedFirst(
        state.tabs.map((tab) =>
          tab.relPath === relPath
            ? // Pinning a preview also makes it permanent: parking something
              // at the left of the strip and then letting the next click
              // replace it would be a trap.
              { ...tab, isPinned: !tab.isPinned, isPreview: false }
            : tab,
        ),
      ),
    })),

  moveTab: (relPath, toIndex) =>
    set((state) => {
      const from = state.tabs.findIndex((tab) => tab.relPath === relPath);
      if (from === -1) return {};

      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!moved) return {};
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, moved);

      // A drag that crosses the pinned boundary is a reorder, not a pin: the
      // tab lands back in its own block rather than silently changing state.
      return { tabs: withPinnedFirst(tabs) };
    }),

  closeOthers: (relPath) =>
    set((state) => {
      const kept = state.tabs.filter(
        (tab) => tab.relPath === relPath || tab.isPinned,
      );
      const keptPaths = new Set(kept.map((tab) => tab.relPath));
      const dropped = state.tabs
        .filter((tab) => !keptPaths.has(tab.relPath))
        .map((tab) => tab.relPath);

      return {
        tabs: kept,
        activeRelPath: relPath,
        secondaryRelPath: keptPaths.has(state.secondaryRelPath ?? "")
          ? state.secondaryRelPath
          : null,
        review: keptPaths.has(state.review?.relPath ?? "") ? state.review : null,
        mru: state.mru.filter((path) => keptPaths.has(path)),
        closed: [...state.closed, ...dropped].slice(-CLOSED_LIMIT),
      };
    }),

  closeToRight: (relPath) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.relPath === relPath);
      if (index === -1) return {};

      // Pinned tabs are left of everything unpinned, so "to the right" can
      // never include one — but a pinned tab dragged rightward within its own
      // block still must not be swept up by a close from an unpinned tab.
      const kept = state.tabs.filter((tab, at) => at <= index || tab.isPinned);
      const keptPaths = new Set(kept.map((tab) => tab.relPath));
      const dropped = state.tabs
        .filter((tab) => !keptPaths.has(tab.relPath))
        .map((tab) => tab.relPath);

      return {
        tabs: kept,
        activeRelPath: keptPaths.has(state.activeRelPath ?? "")
          ? state.activeRelPath
          : relPath,
        secondaryRelPath: keptPaths.has(state.secondaryRelPath ?? "")
          ? state.secondaryRelPath
          : null,
        review: keptPaths.has(state.review?.relPath ?? "") ? state.review : null,
        mru: state.mru.filter((path) => keptPaths.has(path)),
        closed: [...state.closed, ...dropped].slice(-CLOSED_LIMIT),
      };
    }),

  closeSaved: () =>
    set((state) => {
      // Dirty work and pinned tabs both survive. Losing unsaved edits to a
      // convenience command would be the worst bug in this file.
      const kept = state.tabs.filter((tab) => tab.isDirty || tab.isPinned);
      const keptPaths = new Set(kept.map((tab) => tab.relPath));
      const dropped = state.tabs
        .filter((tab) => !keptPaths.has(tab.relPath))
        .map((tab) => tab.relPath);

      return {
        tabs: kept,
        activeRelPath: keptPaths.has(state.activeRelPath ?? "")
          ? state.activeRelPath
          : (kept[0]?.relPath ?? null),
        secondaryRelPath: keptPaths.has(state.secondaryRelPath ?? "")
          ? state.secondaryRelPath
          : null,
        review: keptPaths.has(state.review?.relPath ?? "") ? state.review : null,
        mru: state.mru.filter((path) => keptPaths.has(path)),
        closed: [...state.closed, ...dropped].slice(-CLOSED_LIMIT),
      };
    }),

  takeClosed: () => {
    const { closed, tabs } = get();
    // Skip anything reopened by other means since, so the chord does not
    // hand back a tab that is already on screen.
    const open = new Set(tabs.map((tab) => tab.relPath));
    const remaining = closed.filter((path) => !open.has(path));
    const last = remaining[remaining.length - 1] ?? null;
    if (last) set({ closed: remaining.slice(0, -1) });
    return last;
  },

  setActive: (relPath) =>
    set((state) => ({
      ...(state.focusedPane === "secondary" && state.splitOpen
        ? { secondaryRelPath: relPath }
        : { activeRelPath: relPath }),
      mru: touchMru(state.mru, relPath),
    })),

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
        tab.relPath === relPath
          ? // Typing into a preview keeps it: the edit is the clearest
            // possible statement that this file is not being skimmed.
            { ...tab, isDirty, isPreview: tab.isPreview && !isDirty }
          : tab,
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
      mru: [],
      closed: [],
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

/** Tabs in most-recently-used order, for Ctrl+Tab.
 *
 *  Anything the MRU list has not seen yet (a tab restored from a session,
 *  say) falls in behind in strip order, so the cycle always covers every
 *  open tab rather than only the ones visited this session. */
export const selectMruTabs = (state: OpenTabsStore): OpenTab[] => {
  const byPath = new Map(state.tabs.map((tab) => [tab.relPath, tab]));
  const ordered = state.mru
    .map((path) => byPath.get(path))
    .filter((tab): tab is OpenTab => tab !== undefined);
  const seen = new Set(ordered.map((tab) => tab.relPath));
  return [...ordered, ...state.tabs.filter((tab) => !seen.has(tab.relPath))];
};

/** The tab Ctrl+Tab should land on: the previously used one, wrapping. */
export const selectNextMruTab = (state: OpenTabsStore): OpenTab | null => {
  const ordered = selectMruTabs(state);
  if (ordered.length < 2) return ordered[0] ?? null;
  return ordered[1] ?? null;
};

/** True while any open file has edits that have not reached the server. */
export const selectHasUnsavedWork = (state: OpenTabsStore): boolean =>
  state.tabs.some((tab) => tab.isDirty);
