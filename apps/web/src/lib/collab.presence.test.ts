// @vitest-environment jsdom
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("y-monaco", () => ({
  MonacoBinding: class {
    destroy() {
      // The binding is not what these cases are about.
    }
  },
}));

import {
  installCollab,
  peersIn,
  publishViewport,
  retainDoc,
  viewportIn,
} from "./collab.ts";
import { resetCursorStyles } from "./remoteCursors.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

const PATH = "src/App.jsx";
const OTHER = "src/main.jsx";
const IDENTITY = { name: "me@example.com", color: "hsl(265 70% 62%)" };

function fakeSocket() {
  const handlers = new Map<string, ((payload: never) => void)[]>();
  const emitted: { event: string; payload: unknown }[] = [];

  const socket = {
    on(event: string, handler: (payload: never) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return socket;
    },
    off(event: string, handler: (payload: never) => void) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
      return socket;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };

  return {
    socket: socket as unknown as EditorSocket,
    emitted,
    deliver(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        (handler as (value: unknown) => void)(payload);
      }
    },
  };
}

let harness: ReturnType<typeof fakeSocket>;
let teardown: () => void;

/** Another person in a file, with whatever awareness fields the case needs.
 *
 *  A real `Awareness` over its own `Y.Doc`, so it brings a client id of its
 *  own — which is exactly what the per-person stylesheet is keyed on.
 */
async function joins(
  relPath: string,
  fields: { user?: unknown; viewport?: unknown },
): Promise<number> {
  const { Awareness, encodeAwarenessUpdate } = await import(
    "y-protocols/awareness"
  );

  const theirs = new Awareness(new Y.Doc());
  for (const [key, value] of Object.entries(fields)) {
    theirs.setLocalStateField(key, value);
  }

  const update = encodeAwarenessUpdate(theirs, [theirs.clientID]);
  harness.deliver("docAwareness", {
    relPath,
    update: update.buffer.slice(
      update.byteOffset,
      update.byteOffset + update.byteLength,
    ),
  });

  // The awareness codec is imported dynamically, so the update lands a turn or
  // more later. Waited on rather than slept through.
  await vi.waitFor(() => {
    expect(peersIn(relPath).length).toBeGreaterThan(0);
  });

  return theirs.clientID;
}

function sheet(): string {
  return document.getElementById("rc-remote-cursors")?.textContent ?? "";
}

beforeEach(() => {
  resetCursorStyles();
  document.getElementById("rc-remote-cursors")?.remove();
  harness = fakeSocket();
  teardown = installCollab(harness.socket);
});

afterEach(() => {
  teardown();
});

/** The gap this closes.
 *
 *  `MonacoBinding` has published every local selection into awareness and
 *  decorated every remote one since collaborative editing shipped — tagging
 *  each decoration `yRemoteSelection-<clientID>`. y-monaco ships no stylesheet
 *  for those classes and there was none here, so remote selections rendered as
 *  unstyled spans: in the DOM, invisible on screen.
 *
 *  These cases assert on the document rather than on the renderer, because a
 *  renderer nobody calls produces a perfect stylesheet that never reaches a
 *  page.
 */
describe("other people's cursors reaching the page", () => {
  it("installs rules for someone who joins the file", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const clientId = await joins(PATH, {
      user: { name: "ada@example.com", color: "#ff8800" },
    });

    expect(sheet()).toContain(`.yRemoteSelection-${String(clientId)} {`);
    expect(sheet()).toContain('content: "ada@example.com";');
    expect(sheet()).toContain("border-left: 2px solid #ff8800;");
  });

  /** The same person in two files is two client ids and decorates two
   *  documents. A stylesheet folded by name would leave the second caret
   *  unstyled — which is to say invisible, which is the bug being fixed. */
  it("gives one person a rule per document they are in", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    retainDoc(harness.socket, OTHER, IDENTITY);

    const user = { name: "ada@example.com", color: "#ff8800" };
    const here = await joins(PATH, { user });
    const there = await joins(OTHER, { user });

    expect(here).not.toBe(there);
    expect(sheet()).toContain(`.yRemoteSelection-${String(here)} {`);
    expect(sheet()).toContain(`.yRemoteSelection-${String(there)} {`);
  });

  /** A colour is a string that arrived from another client and is about to be
   *  interpolated into a stylesheet. This is the end-to-end half of
   *  `safeColor`: not that the function refuses it, but that nothing routes
   *  around the function. */
  it("does not let a peer write rules of their own", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    await joins(PATH, {
      user: {
        name: "ada@example.com",
        color: "red; } body { display: none } .x {",
      },
    });

    expect(sheet()).not.toContain("display: none");
    expect(sheet()).toContain('content: "ada@example.com";');
  });

  it("takes the rules away when the document goes", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const clientId = await joins(PATH, {
      user: { name: "ada@example.com", color: "#ff8800" },
    });
    expect(sheet()).toContain(`.yRemoteSelection-${String(clientId)} {`);

    teardown();
    expect(sheet()).toBe("");
  });
});

/** Follow mode's second half.
 *
 *  Following opened the file somebody else was in; it could not put you on the
 *  same part of it, because awareness carried a name and a colour and nothing
 *  about where they were looking. This is that field.
 */
describe("where a collaborator is scrolled to", () => {
  it("reads a viewport a peer published", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    await joins(PATH, {
      user: { name: "ada@example.com", color: "#ff8800" },
      viewport: { top: 120, bottom: 168 },
    });

    expect(viewportIn(PATH, "ada@example.com")).toEqual({
      top: 120,
      bottom: 168,
    });
  });

  it("has none for somebody who has not published one", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    await joins(PATH, {
      user: { name: "ada@example.com", color: "#ff8800" },
    });

    expect(viewportIn(PATH, "ada@example.com")).toBeUndefined();
  });

  /** Per document, not per person. Someone reading line 12 of one file and
   *  line 900 of another has two positions, and answering with either one for
   *  both would scroll a follower to a line that is not where they are. */
  it("keeps one person's two files apart", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    retainDoc(harness.socket, OTHER, IDENTITY);

    const user = { name: "ada@example.com", color: "#ff8800" };
    await joins(PATH, { user, viewport: { top: 12, bottom: 40 } });
    await joins(OTHER, { user, viewport: { top: 900, bottom: 930 } });

    expect(viewportIn(PATH, "ada@example.com")?.top).toBe(12);
    expect(viewportIn(OTHER, "ada@example.com")?.top).toBe(900);
  });

  /** Whatever a peer puts in awareness arrives here unchecked, and this value
   *  is fed to `getTopForLineNumber`. A string or a NaN would scroll the
   *  editor somewhere undefined rather than not scroll it. */
  it("ignores a viewport that is not one", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const user = { name: "ada@example.com", color: "#ff8800" };

    await joins(PATH, { user, viewport: { top: "12", bottom: 40 } });
    expect(viewportIn(PATH, "ada@example.com")).toBeUndefined();

    await joins(PATH, { user, viewport: { top: Number.NaN, bottom: 40 } });
    expect(viewportIn(PATH, "ada@example.com")).toBeUndefined();

    await joins(PATH, { user, viewport: "somewhere" });
    expect(viewportIn(PATH, "ada@example.com")).toBeUndefined();
  });

  it("has none for a file nobody is sharing", () => {
    expect(viewportIn("src/never-opened.js", "ada@example.com")).toBeUndefined();
  });
});

describe("publishing our own viewport", () => {
  function awarenessEmits() {
    return harness.emitted.filter((entry) => entry.event === "docAwareness");
  }

  /** `awareness.on("update")` imports the codec dynamically before it emits,
   *  so every one of these lands a turn or more after the call that caused it.
   *  Waited on rather than slept through — and asserted with a count taken
   *  before, so a case cannot pass on somebody else's packet. */
  async function settle(count: number) {
    await vi.waitFor(() => {
      expect(awarenessEmits()).toHaveLength(count);
    });
  }

  it("puts it on the wire", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const before = awarenessEmits().length;

    publishViewport(PATH, { top: 10, bottom: 40 });
    await settle(before + 1);
  });

  /** Scrolling fires continuously. Awareness broadcasts on every local change,
   *  so publishing unconditionally would put a packet on the socket for every
   *  frame of a flick-scroll — and the lines visible do not change on most of
   *  those frames. */
  it("says nothing when the visible lines have not changed", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const before = awarenessEmits().length;

    publishViewport(PATH, { top: 10, bottom: 40 });
    await settle(before + 1);

    publishViewport(PATH, { top: 10, bottom: 40 });
    publishViewport(PATH, { top: 10, bottom: 40 });

    // A fence, not a sleep. Counting microtasks here made this case vacuous:
    // it passed against a `publishViewport` with no dedupe at all, because the
    // repeats' packets had simply not arrived yet. So the next thing published
    // is a change that certainly does emit, and the assertion is that the
    // count lands on exactly one more. If either repeat had spoken, the total
    // overshoots and never equals it.
    publishViewport(PATH, { top: 11, bottom: 41 });
    await settle(before + 2);
  });

  it("speaks again once they do", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const before = awarenessEmits().length;

    publishViewport(PATH, { top: 10, bottom: 40 });
    await settle(before + 1);

    publishViewport(PATH, { top: 11, bottom: 41 });
    await settle(before + 2);
  });

  it("ignores a file that is not shared", async () => {
    retainDoc(harness.socket, PATH, IDENTITY);
    const before = awarenessEmits().length;

    publishViewport("src/never-opened.js", { top: 10, bottom: 40 });

    // Fenced the same way, and for the same reason: a packet that has not been
    // sent and a packet that has not arrived yet look identical if you only
    // wait a turn.
    publishViewport(PATH, { top: 10, bottom: 40 });
    await settle(before + 1);
  });
});
