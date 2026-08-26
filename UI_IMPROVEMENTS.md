# UI improvements and redesign

_Composed: 2026-08-26, after reading the whole of `apps/web/src` — the token
sheet, the playground layout, and the components that render inside it. Ordered
by leverage; each item notes what it is, why it matters, and where it would
live._

---

## The premise: this does not need a repaint

`apps/web/src/index.css` is already a coherent design system rather than a pile
of hex literals: a token layer, ground planes ordered darkest-to-lightest, a
violet→cyan gradient spent only on the wordmark, primary buttons and focus
glows, and an editor plane (`--rc-editor-bg`, Dracula) deliberately *lighter*
than the chrome so the surface you read sits above the surface you operate.
Elevation uses shadow plus a light top edge. Motion is on one shared easing
curve and honours `prefers-reduced-motion`.

Redesigning that visual language would be motion without progress. What the
product is missing is **structure and reach** — the app is a good-looking
desktop IDE that only works on a wide screen, only with a mouse, and hides the
collaboration it already implements.

---

## Tier 1 — real gaps, not polish

### 1. There is not one responsive breakpoint in the app

```
grep -rn "@media" apps/web/src → index.css:647 (prefers-reduced-motion)
```

That is the only media query in the codebase. `ProjectPlayground` is four
nested `SplitPane`s with hard pixel floors — sidebar `minSize={180}`, editor
`240`, preview `320`, panel `120`, plus a fixed activity rail. Add them up and
the layout crushes below roughly 1100px. The Dashboard grid, the auth pages and
`JoinProject` are untested below ~700px.

- **What:** two stages. (a) Make Dashboard, auth and `JoinProject` genuinely
  mobile-usable — they are cards and forms, so this is layout work only.
  (b) Give the playground a `<900px` mode where sidebar, panel and preview
  become **overlays** driven by the existing activity rail instead of split
  children.
- **Why:** below a laptop width the product is not degraded, it is unusable.
  A shared project link opened on a phone currently goes nowhere.
- **Where:** `pages/ProjectPlayground.tsx`, `components/layout/SplitPane.tsx`,
  `index.css`. The state already exists (`showSidebar` / `showPanel` /
  `showPreview` and the `remember()` persistence) — only the layout branch is
  new.

### 2. Keyboard focus is invisible everywhere

The only focus rule in the codebase is `.rc-chat-input:focus`.
`.rc-icon-button`, `.rc-tab`, `.rc-tree-row`, `.rc-panel-tab` and
`.rc-quickopen-row` each have hover and active states and no focus state — tab
through the IDE and you cannot see where you are. `tabIndex` appears exactly
once in the whole app (`pages/Dashboard.tsx:300`), so tree rows and editor tabs
are not reachable at all: no arrow-key navigation in the file tree, no
`Ctrl+PageUp/PageDown` between tabs.

- **What:** one `:focus-visible` rule expressed in tokens (reuse `--rc-glow`),
  applied to every interactive primitive; roving `tabIndex` on the tree and the
  tab strip; `aria-selected` / `role="tab"` on the strip.
- **Why:** cheapest high-impact change on this list, and the precondition for
  anyone who does not use a mouse.
- **Where:** `index.css`, `components/molecules/TreeNode/TreeNode.tsx`,
  `components/molecules/EditorTabs/EditorTabs.tsx`.

### 3. The collaboration is invisible

`lib/collab.ts` runs full Yjs awareness and already derives a stable colour per
person (`collab.ts:279`). The only place a human ever sees a collaborator is
the member list inside the Share dialog. There is no avatar stack in the
topbar, no "Ana is in `server.js`" marker on a tree row or tab, no follow-mode.

- **What:** a presence stack in the topbar (or the new status bar, see #5),
  a per-file presence dot in the tree and tab strip, and click-to-follow.
- **Why:** the hard half — CRDT plus presence transport — is built and shipping;
  none of the half a user actually perceives is. Highest-value *feature* here.
- **Where:** `lib/collab.ts` already exposes the awareness map; new
  `components/molecules/PresenceStack`, consumed by the topbar and `TreeNode`.

### 4. No command palette

`Ctrl+P` opens files only (`QuickOpen` flattens the tree to files). Every other
action — split the editor, toggle the preview, env vars, stage a hunk, run —
is reachable only by finding the right unlabeled icon. There is no shortcut
cheatsheet anywhere; the bindings are documented solely inside tooltip strings.

- **What:** `Ctrl+Shift+P` over a shared command registry, with the toolbar and
  activity rail rendering *from* that registry rather than hand-placing buttons.
- **Why:** discoverability for everything that is not a file, and it hands #1
  its mobile action menu for free.
- **Where:** new `lib/commands.ts`; `QuickOpen` generalises into a palette;
  `hooks/useHotkeys.ts` binds from the same registry so the cheatsheet cannot
  drift from the bindings.

---

## Tier 2 — structural redesign worth doing

### 5. Move the status bar out of the editor

It currently lives inside `EditorComponent` (`EditorComponent.tsx:725`). Two
consequences: open the split pane and you get **two** status bars, and close
every tab and it disappears entirely.

- **What:** promote it to one app-level bar owned by `ProjectPlayground`.
- **Why:** it then becomes the home for state that has nowhere to live today —
  git branch and dirty count (`SourceControlPanel` already fetches it),
  container/run state, the presence stack from #3, the problems count from #7.
- **Where:** `pages/ProjectPlayground.tsx` renders it; `EditorComponent`
  publishes cursor/language/dirty into a small store instead of rendering chrome.

### 6. Two competing notification systems

The playground stacks antd `Alert banner`s at the top — which push the whole
layout down and force Monaco and xterm to re-measure — while the Dashboard uses
`message` toasts.

- **What:** pick one. Transient failures → toast. Persistent state (read-only,
  disconnected, file changed on disk) → a status-bar chip, not a
  layout-shifting banner.
- **Why:** consistency, and a banner that resizes the editor mid-keystroke is a
  worse bug than the thing it reports.
- **Where:** `pages/ProjectPlayground.tsx` (the `lastError` and
  `externallyChanged` alerts), `pages/Dashboard.tsx`.

### 7. No Problems view

Monaco produces markers and nothing surfaces them.

- **What:** a third bottom-panel tab beside Terminal and Output, plus a count in
  the status bar from #5.
- **Why:** the diagnostics already exist in the editor; today the only way to
  find them is to scroll the file.
- **Where:** `components/organisms/BottomPanel/BottomPanel.tsx`, fed by
  `monaco.editor.onDidChangeMarkers`.

---

## Tier 3 — cheap wins

- **Light theme.** Everything already reads `var(--rc-*)`. The whole cost is a
  second `:root[data-theme="light"]` block, a toggle, and re-deriving the antd
  `ConfigProvider` in `config/theme.ts`. A daylight user currently has no option.
- **Skeletons over spinners.** The Dashboard shows a centred `<Spin size="large">`
  where card-shaped skeletons would hold the layout still.
- **Density / list view on the Dashboard.** Cards only; past ~30 projects a
  compact list beats scrolling.
- **The editor empty state is decorative** — a dimmed logo and one line of text
  (`EditorComponent.tsx:476`). Make it the on-ramp: recent files, "open a file
  (Ctrl+P)", the run command.
- **Tooltips are the only labels.** Eight icon buttons across the topbar and
  rail carry no text, and touch devices get no tooltips at all — another thing
  #1 and #4 resolve together.

---

## Suggested order

**#2 (focus states)** and **#5 (global status bar)** first: both are small and
self-contained, and #5 unblocks #3 and #7. Then #1, which is the largest single
piece of work and the one that changes who can use the product at all.

---

## Progress

- [x] **#2 — focus states and keyboard reach.** A `:focus-visible` ring on the
  custom controls; the explorer is a `role="tree"` with one roving tab stop and
  the WAI-ARIA key rules (pure, in `lib/treeKeys.ts`); the tab strip is a
  `role="tablist"` with arrows and Delete. Two things the plan did not know
  about turned up on the way: the panel's shell tabs held a
  `<span role="button">` *inside* a `<button>` — invalid markup, and the close
  was mouse-only however a browser resolved it — and the search and
  source-control rows were divs with click handlers, so every result was
  visible and none was reachable. Both fixed.
- [x] **#4 — command palette.** Already shipped, before this plan was written:
  `Ctrl+Shift+P` over `lib/commands.ts`, with disabled entries greyed and
  carrying their reason. The plan was composed against an earlier tree.
- [x] **#5 — global status bar.** Promoted out of `EditorComponent` into the
  playground, which retires both bugs the plan names. The dev server's state
  moved into it, being the first thing to take up the room that freed.

- [x] **#7 — Problems view.** A third bottom-panel tab, a badge on it, and
  the counts in the status bar #5 created. One thing the plan could not have
  known: semantic validation is off for TS/JS by design, so this is syntax and
  schema only, and the empty state says so rather than letting a clean list
  read as "this project type checks".

- [x] **#3 — presence.** A stack in the status bar, and a dot per person on
  the tree row and tab for a file they have open. Not click-to-follow: that
  needs cursor positions and scroll sync, which is a new feature rather than a
  display of what already exists. Presence is per document, so it shows people
  who have a file open — someone sitting in the project with nothing open is
  connected but in no document.
- [x] **#6 — one notification system per kind.** A socket error is transient
  and became a toast; a file changed on disk is persistent state and became a
  chip in the status bar. No more banners resizing the editor mid-keystroke.

Still open: **#1** (responsive) and all of Tier 3.
