# `@replit-clone/web`

React 19 + Vite 6. The IDE: file tree, Monaco, terminals, preview, source
control and the assistant panel.

Start here: [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for setup and the
everyday commands, [`docs/SECURITY.md`](../../docs/SECURITY.md) for why the
preview iframe is sandboxed the way it is.

## Layout

```
src/pages/         route components — Dashboard and ProjectPlayground
src/components/    atoms → molecules → organisms, plus layout/ and routing/
src/store/         zustand stores, one concern each
src/lib/           collab (Yjs), editor models, pending writes, commands
src/hooks/         hotkeys, session bootstrap, unsaved-work guard
src/apis/          typed REST clients over the shared response types
src/utils/         pure helpers — fuzzy scoring, diff parsing, extensions
e2e/               Playwright, run separately against a live stack
```

## The three things to know before changing anything

**Subscribe to one value per store, never a whole store.** Reading a whole
store in the playground re-rendered the editor, terminal and preview together
every time anything moved. The existing selectors are deliberate.

**A terminal owns a WebSocket and a PTY.** Panes are hidden with `display:
none` rather than unmounted, because unmounting one kills the shell and loses
its scrollback. The same holds for editor models.

**The event map is in `packages/shared`.** Socket events and REST response
shapes are declared once and imported by both sides, so a renamed event is a
compile error here rather than a silent no-op at runtime.

## Tests

```bash
pnpm --filter '@replit-clone/web' test    # vitest, jsdom
pnpm --filter '@replit-clone/web' e2e     # Playwright, needs a running stack
```

The end-to-end suite runs against a stack you started yourself and skips
cleanly when it is not up (`e2e/global-setup.ts` probes web and API health
first). It gates on two things separately: everything needs the web app and the
database, and only the flows that actually run a project need Docker — so on a
machine with no daemon the rest still run. Each run deletes the project it
made, so a failed run does not eat the container concurrency cap.

Where the image already ships Chromium and forbids Playwright's own download,
point it at the one that is there:

```bash
E2E_CHROMIUM=/path/to/chrome pnpm --filter '@replit-clone/web' e2e
```

## Bundle

Monaco is ~4 MB self-hosted and there is no way around that; it is split into
its own chunk behind the lazily loaded playground route, so the auth and
dashboard pages never pay for it. `chunkSizeWarningLimit` sits just above it so
the warning still fires if anything *else* grows that large. See
`vite.config.ts`.
