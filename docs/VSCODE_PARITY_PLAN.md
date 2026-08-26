# Closing the gap to VS Code

_Written 2026-08-26. A plan for making the editor behave like the VS Code
people have installed locally, for giving every file and every git state the
icon it has there, and for the Replit and CodeSandbox capabilities still
missing. It is deliberately organised by **what is already built**, **what is
cheap**, and **what is genuinely large** — because the three are very far apart
here and treating them as one list is how a plan stops being usable._

---

## 0. The premise

### 0.1 What already exists

This matters before anything else, because a plan that proposes work already
done is worse than no plan. The editor is not a toy. Verified in the source
rather than assumed:

| Capability | State |
|---|---|
| Monaco with per-file models, undo history, view state per tab | ✅ |
| Split editor, two panes over one tab list and one write queue | ✅ |
| Cross-file TypeScript/JavaScript intelligence — the TS worker gets the project's sources | ✅ |
| Problems panel, fed from Monaco markers | ✅ |
| Command palette (`Ctrl+Shift+P`) and Quick Open (`Ctrl+P`) with fuzzy scoring | ✅ |
| Project-wide search **with regex, case, whole-word and replace-all** | ✅ |
| File tree with multi-select, drag-and-drop move, rename, delete, new file/folder | ✅ |
| Format on save, configurable font size, tab size, word wrap, line numbers, minimap | ✅ |
| Real terminal (`xterm` over a WebSocket to a PTY in the container) | ✅ |
| Git: status, diff, staged/unstaged, **stage by hunk**, discard, log, branches, remotes, fetch, pull, push | ✅ |
| GitHub: OAuth, repo import, upstream state, pull requests | ✅ |
| Multiplayer editing with presence and awareness | ✅ |
| **Light and dark theme** — system/light/dark, persisted, follows the OS live, and applied to Monaco, antd and the terminal palette | ✅ |
| File icons, ~40 extensions plus special filenames | ◐ partial |

The theme item deserves emphasis because it was in the request: **light and dark
mode are already built and working.** `store/themeStore.ts` holds the choice,
`hooks/useThemeMode.ts` resolves it and stamps `data-theme` on the document,
every `--rc-*` token hangs off that attribute, `lib/terminalTheme.ts` carries a
hand-tuned light ANSI palette (not the dark one lightened — ANSI colours chosen
for near-black wash out on white), and the command palette has a toggle. What is
actually missing there is narrow, and it is §6.

### 0.2 Monaco is not VS Code, and the difference is not cosmetic

The request is "exactly the same as local VS Code". It is worth being precise
about why that phrase does not have a small answer, because the precision is
what makes the rest of this document a plan rather than a wish list.

VS Code's identity is its **extension host**: a Node process that loads
arbitrary extensions with filesystem, subprocess and native-module access, and
exposes them to the workbench through the `vscode` API. Almost everything people
mean by "VS Code" lives there — Python's language support, ESLint, Prettier,
GitLens, Docker, the debugger UIs, every theme on the marketplace.

Monaco is the *editor widget* carved out of VS Code. It has:

- no extension API, so no marketplace and no extensions;
- no language server client, so no Pyright, gopls or rust-analyzer;
- no debug adapter protocol, so no breakpoints or stepping;
- no workbench — no activity bar, no settings UI, no keybinding editor, no
  task runner. Everything in §0.1 marked ✅ was **built here by hand** on top of
  the widget.

So there are two routes, and they are genuinely different products:

**Route A — run real VS Code.** `openvscode-server` (or `code-server`) is the
actual VS Code workbench compiled to run in a browser against a remote
filesystem. Dropped into the sandbox image, one per project container, it gives
extensions, debugging, language servers, settings sync and the marketplace on
day one, because it *is* VS Code.

The cost is that it replaces most of what is built here. The tree, tabs,
palette, search panel, problems panel, source-control panel and editor settings
are all VS Code's own then — and so are the things this product does that VS
Code does not: the multiplayer layer, the presence stack, the AI panel with
apply-change, the run control, the preview pane. Those either disappear, or get
rebuilt as VS Code extensions, which is a rewrite in a different framework.
Resource cost is real too: a VS Code server is roughly 300–500 MB of RSS per
project on top of the dev server.

**Route B — keep building on Monaco.** Close the gap feature by feature. Most
of the *visible* gap is small (§1, §2 and §6 are days, not months). The
*capability* gap is two items — language servers (§3) and debugging (§4) — and
both are large but tractable, because the protocols are open and the transport
this codebase already has (a WebSocket to a PTY in the container) is most of
what they need.

**Recommendation: Route B.** Not because Route A is wrong, but because the
things this product has that VS Code does not — multiplayer, the assistant, the
preview, deployments — are the reasons to use it, and Route A puts every one of
them behind a rewrite. Route A is worth revisiting only if "the user's own
extensions" becomes a requirement, because that one genuinely cannot be reached
from Monaco.

Everything below assumes Route B.

---

## 1. File icons and language identity

_The explicit ask, and the cheapest high-visibility item in this document._

### 1.1 Where it stands

`components/atoms/FileIcon/FileIcon.tsx` maps about 40 extensions and a dozen
whole filenames to `react-icons` glyphs. It always renders something, so nothing
is blank — but a real project is full of files it has no opinion about: `.vue`,
`.svelte`, `.rs`, `.go`, `.java`, `.php`, `.rb`, `.sh`, `.sql`, `.graphql`,
`.prisma`, `.tf`, `.proto`, `.lock`, `.toml`, and every config file that carries
more meaning than its extension (`tsconfig.json`, `vite.config.ts`,
`docker-compose.yml`, `.eslintrc`, `.prettierrc`, `Makefile`, `.editorconfig`).

`utils/extensionToFileType.ts` — the Monaco language map — is **wider** than the
icon map. That asymmetry is the bug: a `.rs` file is syntax-highlighted as Rust
under a generic file icon.

### 1.2 The work

1. **Adopt a real icon set rather than extending the hand-rolled map.**
   `vscode-icons` and `material-icon-theme` both publish their icon definitions
   as data (a JSON manifest of extension → icon, filename → icon, folder →
   icon) plus SVGs. Vendoring one, or matching its mapping table, is the
   difference between 40 entries and 1,000 — and it is the mapping, not the
   drawing, that is the work.

   Keep the current component's contract (`extension`, `name`) so nothing above
   it changes; replace only what is behind it.

2. **Folder icons.** VS Code gives `src`, `test`, `node_modules`, `.git`,
   `public`, `dist`, `components`, `hooks` and about eighty others their own
   glyph, open and closed. `TreeNode` currently draws one chevron and one
   generic folder. This is the single change that most makes a tree "look like
   VS Code", more than the file icons do.

3. **Derive both maps from one table.** The icon and the Monaco language id
   should not be able to disagree about what a file is. One
   `Record<extension, { language, icon }>`, two accessors — and a test that
   every language in the map has an icon and vice versa, so the asymmetry above
   cannot come back.

4. **Git status on the icon.** VS Code tints a filename by its git state —
   green for untracked, orange for modified, grey with a strikethrough for
   deleted — and puts a letter badge (`U`, `M`, `D`) on the row. The data is
   already there: `SourceControlPanel` reads `git status` and the tree is a
   sibling component. It needs a shared store rather than new plumbing.

5. **Decorations on the folder too.** A collapsed folder containing a modified
   file shows the tint in VS Code, which is what makes a change findable without
   expanding anything.

**Effort:** 1 for the mapping table, 2 for folders, 4 for git decorations —
roughly a week, most of it in item 4.

**Blocked on:** nothing. Item 1 needs one licensing decision (both icon themes
are MIT, but the SVGs should be vendored deliberately rather than hotlinked).

---

## 2. Editor parity

### 2.1 Options that exist in Monaco and are simply not on

These are single lines in the `options` object in `EditorComponent.tsx`, and
each is a thing people notice missing:

| Option | What it gives |
|---|---|
| `bracketPairColorization: { enabled: true }` | The rainbow brackets VS Code has had on by default since 1.67 |
| `stickyScroll: { enabled: true }` | The enclosing class/function pinned to the top of the viewport |
| `inlayHints: { enabled: "on" }` | Inferred parameter names and types inline (TS/JS only, and the worker already produces them) |
| `linkedEditing: true` | Renaming an HTML/JSX tag renames its closing tag |
| `occurrencesHighlight` | Every other use of the symbol under the cursor, highlighted |
| `renderWhitespace: "selection"` | Whitespace shown inside a selection |
| `suggest.preview` / `inlineSuggest` | Ghost-text completion preview |
| `formatOnPaste`, `formatOnType` | The two format triggers beside format-on-save, which is already built |
| `unicodeHighlight` | The homoglyph warnings — a genuine security affordance |
| `rulers: [80, 120]` | Column guides |
| `cursorSurroundingLines` | `scrolloff`, so the cursor is never on the last visible line |

Each should also be exposed in `EditorSettingsDialog`, which today has six rows.
VS Code's settings UI has hundreds; the useful subset is perhaps twenty-five.

**Effort: 1.** This is an afternoon and it is the highest ratio of "feels like VS
Code" to work in the whole document.

### 2.2 Workbench affordances that need building

Monaco has no workbench, so these are components, not options:

- **Breadcrumbs.** The path-plus-symbol bar under the tab strip, each segment a
  dropdown. The symbol half needs `getDocumentSymbols` from the language
  worker — available for TS/JS today, and for everything else once §3 lands.
- **Outline view.** The same symbol data as a sidebar tree. Should share the
  provider with breadcrumbs rather than fetching twice.
- **Peek definition / peek references.** Monaco ships the widget
  (`editor.action.peekDefinition`); it needs the action wired to a keybinding
  and a definition provider behind it.
- **Go to symbol in workspace** (`Ctrl+T`). Quick Open already does fuzzy
  matching over paths; this is the same widget over symbols.
- **Zen mode** and **centred layout**. Pure layout, and the `SplitPane`
  primitive already exists.
- **Editor context menu.** Right-clicking inside the editor currently gets the
  browser's menu. VS Code's has Go to Definition, Rename Symbol, Format
  Document, Change All Occurrences, Refactor. Monaco has an action registry —
  the menu is a presentation layer over `editor.getSupportedActions()`.

**Effort: 5–8**, spread across six independent pieces.

### 2.3 Tab behaviour

`EditorTabs` has close, middle-click close, and split. VS Code has:

- **Preview tabs** — single-click opens italic and is replaced by the next
  single-click; double-click pins it. This is the tab behaviour people most
  notice the absence of, because without it browsing a tree leaves thirty tabs.
- **Drag to reorder**, and drag between panes.
- **Pin tab**, which parks it at the left and exempts it from Close Others.
- **Close Others / Close to the Right / Close Saved / Reopen Closed Editor**
  (`Ctrl+Shift+T`).
- **Overflow chevron** with a dropdown, rather than a scrolling strip.
- **`Ctrl+Tab`** as most-recently-used order, not left-to-right.

**Effort: 3.** All of it is in `openTabsStore` and one component. Preview tabs
alone are worth doing first.

### 2.4 Keybindings

Eight chords are bound today (`useHotkeys` in `ProjectPlayground.tsx`). VS Code
ships several hundred. The realistic target is not parity but **the ones whose
absence is a papercut**: `Ctrl+Shift+E/F/G/D` for the sidebar views, `Ctrl+\`
for split, `Ctrl+1/2` for pane focus, `Alt+↑/↓` move line, `Shift+Alt+↑/↓`
duplicate line, `Ctrl+D` add next occurrence, `Ctrl+Shift+K` delete line,
`Ctrl+Enter` insert line below, `F2` rename, `F8` next problem, `Ctrl+G` go to
line.

Most of those are Monaco actions already registered — they need binding, not
implementing.

Two further items, in order of value:

- **A keybinding registry**, so a chord is declared once next to its command
  instead of in both `commands` and `useHotkeys`. Today those two lists are kept
  in step by hand, and the `keys:` strings in the palette are free text that
  nothing verifies.
- **User-editable keybindings**, which is the registry plus a settings surface.

**Effort: 2** for the chords, **3** for the registry, **3** for user editing.

---

## 3. Language intelligence beyond TypeScript

_The largest item that is worth doing, and the one that most separates this from
VS Code today._

### 3.1 Where it stands

TypeScript and JavaScript have real intelligence: `lib/projectSources.ts` feeds
the whole project to Monaco's bundled TS worker, so completion, hover,
go-to-definition and diagnostics work across files. That is genuinely good.

Python, Go, Rust, Java, PHP, Ruby, C# and everything else get **syntax
highlighting and nothing else**. No diagnostics, no completion beyond
word-based, no go-to-definition, no rename. The Python and Go templates ship
with a toolchain in the container that knows all of this and is never asked.

### 3.2 The design

The Language Server Protocol is the answer, and this codebase already has the
hard part of the transport.

**In the container.** Each sandbox image gains the language server for its
language: `pyright` or `python-lsp-server` for `sandbox-python`, `gopls` for
`sandbox-go`, `typescript-language-server` for `sandbox-node` (which would also
replace the in-browser TS worker with the real thing, and pick up the project's
own tsconfig, ESLint and installed `@types`).

**The bridge.** A language server speaks JSON-RPC over stdio. `terminalGateway`
already owns exactly this shape of problem — a WebSocket upgrade, authorised,
attached to a process inside the container with a bidirectional byte stream. An
`lspGateway` is the same pattern with a different framing: LSP's
`Content-Length` header framing instead of raw PTY bytes, and no TTY (which
`execCapture` already documents as the difference that lets stdout and stderr be
told apart).

**In the browser.** `monaco-languageclient` adapts LSP to Monaco's provider
interfaces. It is the same library the openvscode-server route would use
internally, so this is not a detour.

### 3.3 What it is blocked on

Two real costs, and both are decisions rather than unknowns:

- **Image size.** Pyright pulls Node into the Python image; gopls is ~40 MB;
  rust-analyzer is ~200 MB. Sandbox images grow, and every cold container start
  pays for it.
- **Memory.** A language server is not free: pyright idles around 150–300 MB on
  a real project, rust-analyzer can hold more than a gigabyte. `CONTAINER_MEMORY_MB`
  defaults to 512 for a small VM. **A language server started unconditionally
  would OOM the dev server it is meant to be helping with.**

So it needs a policy, and the policy is the design decision: start the server
lazily on the first file of that language being opened, stop it with the idle
reaper, and refuse to start it at all when the container's memory limit is below
a threshold — saying so, rather than starting one and letting the run die.

**Smallest honest first step:** Python only, on `sandbox-python`, gated behind a
`LSP_ENABLED` flag, with the memory policy in place from the first commit rather
than added after the first OOM.

**Effort: 13.** The gateway is a week; the client wiring is a week; the policy
and its failure modes are another.

---

## 4. Debugging

_The single largest item in this document, and the one most worth deferring._

VS Code's debugger is breakpoints, stepping, a call stack, a variables pane, a
watch list, an evaluating console, conditional and logpoint breakpoints, and
`launch.json`. It speaks the **Debug Adapter Protocol** to a per-language
adapter (`debugpy`, `delve`, `js-debug`).

Monaco has **none of this** — not the gutter, not the panes, not the protocol.
Unlike LSP, where `monaco-languageclient` does the adapting, there is no
equivalent for DAP: the entire debug UI is VS Code's workbench, not the editor
widget.

So this is: a DAP client, a gateway to an adapter in the container (the same
shape as §3.2), a breakpoint gutter and decoration layer in Monaco, and four new
panels. It is the one item where **Route A pays for itself outright**, because
VS Code has all of it and building it is months.

**Recommendation:** do not build this. Revisit only if debugging becomes the
reason people are choosing something else — and if it does, that is the argument
for Route A, not for building a debugger.

**Interim:** `console.log` and the terminal already work, and `debugpy --wait`
attached from the user's own local VS Code over a forwarded port is a real
answer that costs almost nothing to document.

---

## 5. Git parity

Git here is further along than most of this document — hunk staging in
particular is a feature many editors do not have. What VS Code has and this does
not:

1. **Gutter decorations in the editor.** The green/blue/red bars in the margin
   showing added, modified and deleted lines against HEAD, and the inline diff
   that opens when you click one. This is the most visible missing git feature
   by a wide margin, and the data — `gitService.diff` — is already there. It
   needs a Monaco decoration layer and a debounce against the diff.
2. **Inline blame.** The dimmed "You, 3 days ago" at the end of the current
   line. `git blame --porcelain` through `execCapture`, cached per file and
   invalidated on save.
3. **Merge conflict resolution.** Today a conflicted file shows raw `<<<<<<<`
   markers. VS Code renders Accept Current / Accept Incoming / Accept Both /
   Compare above each block. Pull can produce conflicts already, so this is a
   state the product can reach and has no answer for.
4. **The three-way merge editor.** VS Code's newer conflict UI. Worth listing,
   not worth doing before item 3.
5. **Stash.** `git stash push/pop/list/apply`, and a Stashes section in the
   panel. Small and self-contained.
6. **Tags**, and creating one at a commit.
7. **Timeline view.** Per-file history, with a diff against any earlier commit.
   `gitService.history` exists and takes a path; this is presentation.
8. **Commit amend, and undo last commit.** Both are one flag on commands that
   already exist.
9. **Rebase, cherry-pick, revert.** Genuinely more dangerous, and each needs a
   conflict story — so they come after item 3, not before.
10. **Line-level staging.** Hunk staging is built; VS Code can stage a single
    line inside a hunk. `patchForHunks` is the function this would extend.

**Order:** 1, 3, 2, 5, 8, 7, then the rest.
**Effort:** 5 for gutter decorations, 5 for conflicts, 3 for blame, 2 for
stash — the first four are about three weeks together.

---

## 6. Theme

**Light and dark mode are built** (§0.1). What remains is narrow, and stating it
narrowly is the point:

1. **The light editor theme is Monaco's stock `vs`.** Dark gets Dracula, tuned
   against `--rc-editor-bg`; light gets the default, which does not match the
   app's palette around it. A hand-built light theme JSON beside
   `theme/dracula.json` is half a day and closes the one visible seam.
2. **More than three themes.** VS Code ships a dozen and the marketplace has
   thousands. A theme is a JSON file of token colours plus a `--rc-*` block —
   supporting four or five named themes (Dracula, One Dark, Solarized Light,
   GitHub Light/Dark) is a data change, not an architecture change. It needs a
   picker in `EditorSettingsDialog` beside the existing System/Light/Dark
   segmented control, and the store's `ThemeChoice` widened from three values.
3. **High contrast.** VS Code has HC Dark and HC Light, and they are an
   accessibility feature rather than a preference. The token system already
   supports it; nothing consumes `prefers-contrast`.
4. **Theme the remaining surfaces.** The terminal is done properly. Worth
   auditing: the xterm **selection and search highlight**, the Monaco **diff
   editor** colours (which currently inherit and can be near-illegible on
   light), and the preview pane's "nothing running" fallback page, which is
   hardcoded dark in `routes/preview.ts` and `deploySite.ts`.
5. **Respect `prefers-reduced-motion`.** `cursorSmoothCaretAnimation`,
   `smoothScrolling` and the drawer transitions should all stand down.

**Effort: 3** for all five. Item 4 is the one with an actual bug in it.

---

## 7. Databases — a Postgres and a MongoDB template, with a live query editor

_Added 2026-08-26 at request. This is two separable features that are easy to
conflate, and conflating them is how the smaller one gets blocked behind the
larger. Splitting them is the first decision in this section._

### 7.1 The two halves, and why they are separate

**Half one — a database a project's app can actually talk to.** This is
`REPLIT_CLONE_PLAN.md` §8.3, and it is infrastructure: something has to run
Postgres or MongoDB, per project, with credentials injected into the container
and a disk budget attached. Templates are what make it visible, but templates
are the easy part.

**Half two — a database client inside the editor.** A schema tree, a table
browser and a query editor with a result grid. This is a UI feature over a
connection, and it does **not** require half one: a connection string in the
project's existing secrets — a Neon, Supabase, Atlas or Railway database the
user already has — is a perfectly good thing to point it at, and is what most
people will actually use.

So half two can ship first, alone, and be useful. That ordering is the whole
recommendation of this section.

### 7.2 The security decision that comes before any code

**A user-supplied connection string is a server-side request forgery
primitive**, and it is the single most dangerous thing in this section.

The query runs on the server (it must — see §7.5), so a connection string the
user types is a host and a port the *server* dials, from inside the deployment's
network, with the deployment's own reachability. Pointed at
`postgresql://replit:replit@localhost:15432/replit_clone`, the query editor
becomes a shell on the platform's own database: every user row, every password
hash, every encrypted GitHub token.

That is not hypothetical — the platform's Postgres is on loopback on the very
host the server runs on, and the credentials are in the same `.env` the server
reads.

So, non-negotiably:

1. **A managed database's connection is resolved server-side from the project
   id.** It is never sent by the client, never echoed back in full, and the
   password never leaves the server. The client addresses "this project's
   database", not a URL.
2. **An external connection string is treated as attacker-controlled.** Before
   any connection: resolve the hostname and refuse loopback, link-local
   (`169.254.0.0/16` — the cloud metadata endpoint) and every RFC 1918 range
   unless an operator has explicitly allowed it. Re-check **after** DNS
   resolution and pin the resolved address, because a name that resolves to a
   public address on the first lookup and to `127.0.0.1` on the second is the
   standard way this check is defeated.
3. **The platform's own `DATABASE_URL` host and port are denied outright**, by
   value, as a second line that does not depend on the range check being
   complete.
4. **The string is a secret.** Stored through `lib/secretBox.ts` — which exists
   and already does exactly this for the GitHub token — never in `envVars` as
   plaintext, never logged, and redacted in every error message the way
   `gitService.redactToken` already redacts a push token.

**If any of this is not in the first commit, external connections should not be
in the first commit.** Managed-only is a complete, useful feature on its own.

### 7.3 Where a managed database runs

Three options, and they are genuinely different products:

| | How | Cost | Isolation |
|---|---|---|---|
| **A. Sidecar container per project** | `rc-db-<projectId>` running `postgres:17-alpine` or `mongo:7` on the sandbox network, data in a named volume | ~30–50 MB idle for Postgres, ~100–200 MB for Mongo | By construction — separate container, separate volume, its own credentials |
| **B. Shared cluster, database-per-project** | One Postgres, a `CREATE DATABASE` and a `CREATE ROLE` per project | One process for everyone | By grant. Correct is achievable, but every mistake is cross-tenant |
| **C. Embedded** | PGlite inside the project container | Nearly free | Total, but it is not really Postgres and has no Mongo equivalent |

**Recommendation: A.** It is the only one that gives Postgres and MongoDB the
same shape, it reuses machinery that already exists (`SANDBOX_NETWORK`, named
volumes, `startIdleReaper`, the per-user container caps), and its isolation is
structural rather than a set of grants that have to stay right.

The cost is memory, and it is the honest objection: `MAX_CONCURRENT_CONTAINERS`
defaults to 3, and this makes every database-backed project cost two container
slots instead of one. That has to be counted properly rather than discovered —
see §7.4.

### 7.4 The managed database, concretely

**A field on the project, not only on the template.** `Project.database:
"postgres" | "mongodb" | null`. Templates preset it; anything else can turn it
on later. A user who started from the React template and then needed a database
should not have to start over — which is exactly what a template-only design
forces.

**Provisioning** (`service/databaseService.ts`, mirroring `deployService.ts`):

- Generate a password with `randomBytes`, seal it with `secretBox`, store it on
  a `ProjectDatabase` row alongside the engine, the database name and the volume
  name.
- Start `rc-db-<projectId>` on `SANDBOX_NETWORK` with `POSTGRES_PASSWORD` /
  `MONGO_INITDB_ROOT_PASSWORD` from the sealed value, publishing **nothing** to
  the host — exactly as project containers publish nothing.
- Wait for readiness by polling `pg_isready` / a `ping` command through
  `execCapture`, not by sleeping. `containers/devServerProbe.ts` is the shape to
  copy.
- Inject `DATABASE_URL` / `MONGODB_URI` into the project container at start,
  through the same path `projectEnvService.toDockerEnv` already uses — so they
  appear in the run environment and are **not** written into a file in the
  user's tree, where they would be committed, exported and listed in the file
  panel.

**Lifecycle:**

- The idle reaper must treat the pair as one unit. Stopping a project's
  container while its database keeps running is a memory leak with extra steps;
  stopping the database while the app runs is an outage the user did not cause.
- **The env signature must include the database's identity.** `envSignature`
  already forces a container rebuild when the environment changes; provisioning
  a database changes `DATABASE_URL`, and a container started before it would
  otherwise keep the old, absent value for the rest of its life.
- Deleting the project removes the container **and the volume** — the same
  lesson `deployService.unpublish` learned about published files outliving the
  row that pointed at them.
- Disk: the volume needs its own quota line beside `PROJECT_DISK_QUOTA_MB`. A
  database is the easiest way in the whole product to fill a disk.

**Quotas:** `MAX_CONCURRENT_CONTAINERS` and `MAX_CONTAINERS_PER_USER` must count
database containers. If they do not, the caps silently double and the VM the
defaults were chosen for stops fitting.

### 7.5 The query editor

**It runs on the server, always.** Not from the browser: the browser cannot
reach the sandbox network, a connection string in client JavaScript is a
credential handed to the user's own page, and the row and time caps below are
only enforceable somewhere the client cannot skip them.

The transport is the existing socket, or a small REST surface under
`/api/v1/projects/:projectId/database/*` alongside the package and deployment
routes. Postgres through `pg` (already a dependency); MongoDB through the
official driver.

**Five limits, each for a reason that has already bitten this codebase:**

| Limit | Why |
|---|---|
| `statement_timeout` on every session | A cartesian join holds a connection and a request forever |
| Row cap (~1,000, with "showing first N") | `execCapture` learned this: an unbounded result buffers into the server's memory before anyone sees it |
| Byte cap on the serialised result | A thousand rows of `bytea` is not a thousand small rows |
| One pooled connection per project, idle-closed | A pool per open tab exhausts `max_connections` at about twenty users |
| Rate limit on execute | Same shape as `installLimiter` and `deployLimiter` |

**Access level decides what may run, and the database enforces it, not the UI.**
A viewer must not be able to `DROP TABLE`. Hiding the button is not a control —
the endpoint is still there. A viewer's session runs as a **read-only role** (or
inside `BEGIN READ ONLY` on Postgres, and against a read-only user on Mongo), so
the refusal comes from the database and cannot be routed around.

**Statement classification is advisory, not a boundary.** Parsing SQL to decide
whether something is "just a SELECT" is a losing game — CTEs with `INSERT …
RETURNING`, `DO` blocks, functions with side effects. Use it to *warn* ("this
will modify data"), never to *permit*.

**Never log query text.** It contains the user's data by definition. Log the
duration, the row count and the error code.

### 7.6 Schema browsing and the table view

**Introspection**, cached per connection and invalidated on any non-read
statement:

- Postgres: `information_schema` / `pg_catalog` for schemas, tables, views,
  columns with types and nullability, primary and foreign keys, indexes.
- MongoDB: `listCollections`, plus **sampled** inference — a collection has no
  declared schema, so the field list comes from `$sample` over a few hundred
  documents and must be labelled as inferred rather than presented as truth.

**The tree** (a new sidebar view, database icon): connection → databases →
schemas → tables/collections → columns/indexes. It should reuse `TreeNode`'s
keyboard handling rather than growing a second tree with different arrow keys.

**The table grid**, opened by clicking a table:

- Server-side pagination (`LIMIT`/`OFFSET`, or `skip`/`limit`), never fetching
  a whole table.
- Sort by clicking a column header; filter per column.
- Typed rendering: `NULL` shown as a distinct dim token and **not** as an empty
  string — telling those two apart is most of what a data grid is for. `json`
  and `jsonb` expand into a tree; timestamps show their timezone; `bytea` shows
  a size, not bytes.
- A row detail panel — which for MongoDB is the *primary* view rather than a
  secondary one, because a document is not a row and a grid flattens it badly.
- Inline editing is **deliberately out of the first version.** An `UPDATE`
  generated from a grid needs a reliable row identity, and a table without a
  primary key does not have one. Getting that wrong writes to the wrong row.

**The editor pane** is Monaco with `pgsql` (a tokenizer it already ships), a Run
button, `Ctrl+Enter` to execute, and the result grid below. Multiple statements
run as a batch with a result tab per statement, the way every SQL client does.

**Completion of table and column names** is the detail that makes this feel
finished rather than merely functional: a Monaco completion provider fed from
the introspected schema, suggesting tables after `FROM`/`JOIN` and that table's
columns once it is named. It is a day's work on data already fetched for the
tree, and it is the difference between a query box and a query editor.

For MongoDB the editor is **not** SQL and must not pretend to be. The input is a
JavaScript/EJSON filter document, or an aggregation pipeline, against a chosen
collection — with the same result grid behind it. Papering over that difference
produces something that is wrong about both databases.

### 7.7 The templates

Small, once §7.4 exists — a template is then a `filesDir` plus `database:
"postgres" | "mongodb"`:

- **`node-express-postgres`** — Express, `pg`, a `schema.sql` and a seed script,
  and one route that reads from a table, so the preview shows real rows on the
  first run.
- **`node-express-mongo`** — Express, the Mongo driver, a seed script, one
  route.
- **`nextjs-postgres`** (Prisma) and **`python-fastapi-postgres`** (SQLAlchemy)
  are the obvious next two, and are worth holding until the first two have been
  used in anger.

Each template's `startCommand` runs its migration before the dev server, so a
project is useful on first open rather than after a README. That composes with
warm start: `containers/warmStart.ts` splits `<install> && <serve>` on the first
`&&` and treats everything after it as the serve half — so a migration step sits
in the serve half and keeps running on every start, which is what a migration
should do, being idempotent by design.

**One caution worth stating:** `staticBuild` must stay absent on all of these. A
database-backed app serves requests from a running process, and §8.1's deploy
path already refuses those with a clear message. A template that offered a
static deploy button and then produced a site with no data behind it would be
worse than one that says no.

### 7.8 Effort, and the order within this section

| Item | Effort | Depends on |
|---|---|---|
| §7.2 SSRF guard + secret storage | 3 | nothing |
| §7.5–7.6 client against an **external** connection string | 8 | §7.2 |
| §7.4 managed sidecar provisioning and lifecycle | 13 | a memory/quota decision |
| §7.7 templates | 2 | §7.4 |
| Schema-aware completion | 1 | §7.6 |
| Inline grid editing | 5 | §7.6, and a row-identity design |

**Order: §7.2, then the client against an external connection, then the managed
sidecar, then the templates.** That way the largest and most contentious piece —
running a database per project on a VM sized for three containers — gets decided
with a working client already in hand to justify it, rather than up front on
faith.

---

## 8. Replit and CodeSandbox, beyond the editor

`REPLIT_CLONE_PLAN.md` §8 is the live scoring of this and should stay the single
source of truth rather than being duplicated here. As it stands:

- **§8.1 static deployments** — ✅ done.
- **§8.2 warm containers** — ◐ installs are skipped when nothing changed; the
  dev server process still dies with the container. A memory snapshot that
  resumes a running process is CodeSandbox's actual feature and needs a decision
  about how much disk a suspended project may hold.
- **§8.3 persistent data** — ❌. No database or KV a user's app can talk to.
  Blocked on isolation: a per-project Postgres with generated credentials, or a
  KV service on the sandbox network with per-project tokens. **§7 above is the
  detailed design for this**, and supersedes the two-line sketch there — with
  the addition that §7 splits off the query editor as something that can ship
  first and without any of this.
- **§8.4 package management UI** — ✅ done.
- **§8.5 fork / public projects** — ❌. Blocked on a visibility model and its
  consequences: abuse surface, quota accounting for a fork, and whether secrets
  and remotes are stripped on copy. **The last is a security requirement, not a
  nicety.**

Two further items from the same section that belong in an *editor* plan:

- **Follow mode.** Presence already shows who is here and which file they are
  in; riding along with their viewport is a small addition to a layer that
  exists.
- **Checkpoint history outside git.** Replit recovers a file from before the
  first commit. Here an uncommitted mistake is gone. Monaco holds an undo stack
  per model and the server already writes every save — a periodic snapshot with
  a retention window is a contained feature and a genuinely reassuring one.

---

## 9. Order

By visible value per unit of work, and by how little each depends on a decision
nobody has made:

1. **§2.1 — Monaco options.** An afternoon. Bracket colourisation, sticky
   scroll, inlay hints, linked editing. Nothing feels more like VS Code for
   less.
2. **§1.1–1.3 — the icon table.** A real icon set, folder icons, one shared
   extension map. Days.
3. **§2.3 — preview tabs and tab reordering.** The tab behaviour whose absence
   is felt every time somebody browses a tree.
4. **§6 — the light editor theme and the theming audit.** Half a week, and it
   closes a seam visible on every light-mode screen.
5. **§5.1 — git gutter decorations.** The most visible missing git feature, and
   the data already exists.
6. **§1.4–1.5 — git decorations on the tree.** Depends on the same store as 5.
7. **§7.2 + §7.5–7.6 — the database client, against an external connection.**
   The SSRF guard first, then the schema tree, the table grid and the query
   editor. Useful on its own, needs no new infrastructure, and is what makes the
   managed database worth paying for.
8. **§2.2 — breadcrumbs, outline, peek, editor context menu.**
9. **§5.3 — merge conflict resolution.** A state the product can already reach
   and has no answer for.
10. **§7.4 + §7.7 — the managed sidecar database, then the templates.** The
    memory and quota decision has to be made before this starts, not during it.
11. **§2.4 — the keybinding registry**, then the chords, then user editing.
12. **§3 — language servers, Python first.** Needs the memory policy decided
    before the first line.
13. **§8 — checkpoint history**, then follow mode.
14. **§4 — debugging.** Deferred, on purpose. If this becomes the deciding
    feature, the answer is Route A, not a hand-built debugger.

Items 1–6 are roughly two weeks and cover most of what "make it look and feel
like VS Code" actually means to somebody using it. Item 7 is the database
feature at its smallest useful size. Items 8–11 are the next two months. Items
10 and 12 are the two that change what the product can do.
