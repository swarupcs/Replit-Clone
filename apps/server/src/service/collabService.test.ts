import fs from "node:fs/promises";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRoot } from "../utils/projectPaths.js";
import {
  applyDocUpdate,
  CONTENT_KEY,
  detectExternalChange,
  docsForSocket,
  flushDoc,
  forgetProject,
  isLive,
  joinDoc,
  leaveDoc,
  resetCollabState,
} from "./collabService.js";

const PROJECT = "2b4c6d8e-1a3f-4b5c-8d9e-0f1a2b3c4d5e";
const root = projectRoot(PROJECT);
const FILE = "notes.txt";

const read = () => fs.readFile(`${root}/${FILE}`, "utf8");

/** A client: its own Y.Doc, synced through the server the way the real one is. */
function client(id: string, state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);

  return {
    id,
    doc,
    text: () => doc.getText(CONTENT_KEY),
    /** Edits locally and hands the resulting update to the server. */
    edit(mutate: (text: Y.Text) => void) {
      const before = Y.encodeStateVector(doc);
      doc.transact(() => mutate(doc.getText(CONTENT_KEY)));
      return Y.encodeStateAsUpdate(doc, before);
    },
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update);
    },
  };
}

beforeEach(async () => {
  resetCollabState();
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(`${root}/${FILE}`, "hello");
});

afterEach(async () => {
  resetCollabState();
  await fs.rm(root, { recursive: true, force: true });
});

describe("joining", () => {
  it("loads the file's contents into the document", async () => {
    const { doc } = await joinDoc(PROJECT, FILE, "s1");
    expect(doc.getText(CONTENT_KEY).toJSON()).toBe("hello");
  });

  it("gives a newcomer state that reproduces the document", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    expect(client("s2", state).text().toJSON()).toBe("hello");
  });

  it("shares one document between everyone who joins", async () => {
    const first = await joinDoc(PROJECT, FILE, "s1");
    const second = await joinDoc(PROJECT, FILE, "s2");

    expect(second.doc).toBe(first.doc);
  });

  it("reports which files a socket has open", async () => {
    await joinDoc(PROJECT, FILE, "s1");
    await fs.writeFile(`${root}/other.txt`, "x");
    await joinDoc(PROJECT, "other.txt", "s1");

    expect(docsForSocket("s1").map((entry) => entry.relPath).sort()).toEqual([
      FILE,
      "other.txt",
    ]);
    expect(docsForSocket("s2")).toEqual([]);
  });
});

describe("merging concurrent edits", () => {
  it("keeps both people's work when they type at the same time", async () => {
    // The whole point: last-write-wins used to mean whoever stopped typing
    // last silently overwrote the other.
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    await joinDoc(PROJECT, FILE, "s2");

    const a = client("s1", state);
    const b = client("s2", state);

    // Neither has seen the other's change when they make their own.
    const fromA = a.edit((text) => text.insert(0, "A says: "));
    const fromB = b.edit((text) => text.insert(5, " and B was here"));

    applyDocUpdate(PROJECT, FILE, fromA, "s1");
    applyDocUpdate(PROJECT, FILE, fromB, "s2");

    b.receive(fromA);
    a.receive(fromB);

    const merged = a.text().toJSON();
    expect(merged).toBe(b.text().toJSON());
    expect(merged).toContain("A says: ");
    expect(merged).toContain("and B was here");
  });

  it("converges however the updates are ordered", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    const a = client("s1", state);
    const b = client("s2", state);

    const fromA = a.edit((text) => text.insert(0, "one "));
    const fromB = b.edit((text) => text.insert(0, "two "));

    // Applied in opposite orders on the two clients.
    a.receive(fromB);
    b.receive(fromA);

    expect(a.text().toJSON()).toBe(b.text().toJSON());
  });

  it("survives a deletion racing an insertion in the same region", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    const a = client("s1", state);
    const b = client("s2", state);

    const fromA = a.edit((text) => text.delete(0, 5));
    const fromB = b.edit((text) => text.insert(2, "XX"));

    a.receive(fromB);
    b.receive(fromA);

    expect(a.text().toJSON()).toBe(b.text().toJSON());
  });
});

describe("persistence", () => {
  it("writes the merged result to disk", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    const a = client("s1", state);

    applyDocUpdate(PROJECT, FILE, a.edit((t) => t.insert(5, " world")), "s1");
    await flushDoc(PROJECT, FILE);

    expect(await read()).toBe("hello world");
  });

  it("writes nothing when the contents have not changed", async () => {
    await joinDoc(PROJECT, FILE, "s1");
    const before = (await fs.stat(`${root}/${FILE}`)).mtimeMs;

    await flushDoc(PROJECT, FILE);

    expect((await fs.stat(`${root}/${FILE}`)).mtimeMs).toBe(before);
  });

  it("flushes when the last person leaves", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    await joinDoc(PROJECT, FILE, "s2");

    const a = client("s1", state);
    applyDocUpdate(PROJECT, FILE, a.edit((t) => t.insert(0, "saved: ")), "s1");

    // Someone is still editing, so the document stays live.
    await leaveDoc(PROJECT, FILE, "s1");
    expect(isLive(PROJECT, FILE)).toBe(true);

    await leaveDoc(PROJECT, FILE, "s2");
    expect(isLive(PROJECT, FILE)).toBe(false);
    expect(await read()).toBe("saved: hello");
  });

  it("reloads from disk once everyone has left", async () => {
    // Otherwise a file edited in a terminal would be served stale forever.
    await joinDoc(PROJECT, FILE, "s1");
    await leaveDoc(PROJECT, FILE, "s1");

    await fs.writeFile(`${root}/${FILE}`, "changed outside");
    const { doc } = await joinDoc(PROJECT, FILE, "s2");

    expect(doc.getText(CONTENT_KEY).toJSON()).toBe("changed outside");
  });

  it("ignores an update for a file nobody has open", () => {
    expect(applyDocUpdate(PROJECT, "gone.txt", new Uint8Array(), "s1")).toBe(false);
  });
});

describe("external changes", () => {
  it("does not report our own write coming back", async () => {
    const { state } = await joinDoc(PROJECT, FILE, "s1");
    const a = client("s1", state);

    applyDocUpdate(PROJECT, FILE, a.edit((t) => t.insert(0, "ours ")), "s1");
    await flushDoc(PROJECT, FILE);

    expect(await detectExternalChange(PROJECT, FILE)).toBe(false);
  });

  it("reports a change made outside the editor", async () => {
    await joinDoc(PROJECT, FILE, "s1");
    await fs.writeFile(`${root}/${FILE}`, "a build step rewrote this");

    expect(await detectExternalChange(PROJECT, FILE)).toBe(true);
  });

  it("leaves the document alone rather than guessing at a merge", async () => {
    // An external writer produces whole new contents with no record of which
    // edits made them, so there is nothing to merge against.
    const { doc } = await joinDoc(PROJECT, FILE, "s1");
    await fs.writeFile(`${root}/${FILE}`, "clobbered");

    await detectExternalChange(PROJECT, FILE);

    expect(doc.getText(CONTENT_KEY).toJSON()).toBe("hello");
  });

  it("says nothing about a file nobody has open", async () => {
    expect(await detectExternalChange(PROJECT, FILE)).toBe(false);
  });
});

describe("cleanup", () => {
  it("drops every document for a deleted project", async () => {
    await joinDoc(PROJECT, FILE, "s1");
    forgetProject(PROJECT);

    expect(isLive(PROJECT, FILE)).toBe(false);
  });
});
