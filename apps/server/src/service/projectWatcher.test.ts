import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { projectRoot } from "../utils/projectPaths.js";
import { retainProjectWatcher } from "./projectWatcher.js";

const PROJECT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const root = projectRoot(PROJECT);

const releases: (() => void)[] = [];

function watch(onChange: () => void): () => void {
  const release = retainProjectWatcher(PROJECT, onChange);
  releases.push(release);
  return release;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (releases.length) releases.pop()?.();
  await fs.rm(root, { recursive: true, force: true });
});

describe("retainProjectWatcher", () => {
  it("notifies once for a burst, not once per event", async () => {
    await fs.mkdir(root, { recursive: true });
    let calls = 0;
    watch(() => (calls += 1));
    await settle(300);

    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(`${root}/file-${String(i)}.txt`, "x");
    }
    await settle(1500);

    expect(calls).toBeGreaterThan(0);
    // Five writes used to mean five broadcasts, each triggering a full tree
    // refetch in every connected client.
    expect(calls).toBeLessThan(5);
  });

  it("ignores changes under directories the tree never shows", async () => {
    await fs.mkdir(`${root}/node_modules/pkg`, { recursive: true });
    await fs.mkdir(`${root}/.git`, { recursive: true });
    let calls = 0;
    watch(() => (calls += 1));
    await settle(300);

    await fs.writeFile(`${root}/node_modules/pkg/index.js`, "x");
    await fs.writeFile(`${root}/.git/HEAD`, "ref: x");
    await settle(1200);

    expect(calls).toBe(0);
  });

  it("keeps watching while another subscriber remains", async () => {
    await fs.mkdir(root, { recursive: true });
    let calls = 0;
    const releaseFirst = watch(() => (calls += 1));
    watch(() => undefined);
    await settle(300);

    // The first tab closes; the second is still open.
    releaseFirst();

    await fs.writeFile(`${root}/after.txt`, "x");
    await settle(1200);

    expect(calls).toBeGreaterThan(0);
  });

  it("stops once the last subscriber leaves", async () => {
    await fs.mkdir(root, { recursive: true });
    let calls = 0;
    const release = watch(() => (calls += 1));
    await settle(300);

    release();
    await fs.writeFile(`${root}/after.txt`, "x");
    await settle(1200);

    expect(calls).toBe(0);
  });

  it("survives a release being called twice", async () => {
    await fs.mkdir(root, { recursive: true });
    const release = watch(() => undefined);
    watch(() => undefined);

    release();
    // socket.io can fire a disconnect handler more than once; a double release
    // must not tear down a watcher the other tab still depends on.
    expect(() => release()).not.toThrow();
  });
});
