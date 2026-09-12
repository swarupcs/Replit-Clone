import { afterEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import pack from "tar-stream";

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { unpackLayer } from "./featureRegistry.js";

/** A real tar.gz, built here, so the test exercises the same path a registry's
 *  bytes take rather than a stand-in for it. */
async function targz(entries: { name: string; body?: string; type?: string; target?: string }[]) {
  const tar = pack.pack();
  for (const entry of entries) {
    if (entry.type === "symlink") {
      tar.entry({ name: entry.name, type: "symlink", linkname: entry.target ?? "/etc" });
    } else {
      tar.entry({ name: entry.name }, entry.body ?? "");
    }
  }
  tar.finalize();

  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  await pipeline(tar, gzip);
  return Buffer.concat(chunks);
}

const made: string[] = [];

/** A target with a parent of its own.
 *
 *  Two levels rather than one, so an entry that escapes lands in a directory
 *  this test owns and deletes. The first version unpacked straight into a
 *  mkdtemp folder, which meant that with the guard removed -- as a mutation
 *  check removes it -- the archive really did write `/tmp/escaped.sh`, and it
 *  stayed there and failed the NEXT run. A test that can only pass once is
 *  worse than no test.
 */
async function tempDir(): Promise<{ parent: string; target: string }> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-feature-test-"));
  made.push(parent);
  const target = path.join(parent, "feature");
  await fsp.mkdir(target);
  return { parent, target };
}

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("unpacking a feature's archive", () => {
  it("writes the files it contains", async () => {
    const { target: dir } = await tempDir();
    await unpackLayer(
      await targz([
        { name: "devcontainer-feature.json", body: '{"id":"node"}' },
        { name: "install.sh", body: "#!/bin/sh\n" },
      ]),
      dir,
    );

    expect(await fsp.readFile(path.join(dir, "install.sh"), "utf8")).toContain("#!/bin/sh");
  });

  it("refuses an entry that climbs out of the folder", async () => {
    const { parent, target } = await tempDir();

    // The oldest trick there is, and this archive is about to be run as root.
    await expect(
      unpackLayer(await targz([{ name: "../escaped.sh", body: "x" }]), target),
    ).rejects.toThrow(/escape/);

    // And nothing was written where it aimed.
    await expect(fsp.access(path.join(parent, "escaped.sh"))).rejects.toThrow();
  });

  it("refuses an absolute path", async () => {
    const { target: dir } = await tempDir();
    await expect(
      unpackLayer(await targz([{ name: "/etc/cron.d/rc", body: "x" }]), dir),
    ).rejects.toThrow();
  });

  it("drops a symlink rather than following it out", async () => {
    const { target: dir } = await tempDir();
    await unpackLayer(
      await targz([
        { name: "escape", type: "symlink", target: "/etc/passwd" },
        { name: "install.sh", body: "ok" },
      ]),
      dir,
    );

    // The same attack wearing a hat, and nothing in a feature needs one.
    await expect(fsp.lstat(path.join(dir, "escape"))).rejects.toThrow();
    expect(await fsp.readFile(path.join(dir, "install.sh"), "utf8")).toBe("ok");
  });

  it("creates the folders an entry needs", async () => {
    const { target: dir } = await tempDir();
    await unpackLayer(await targz([{ name: "bin/helper.sh", body: "x" }]), dir);
    expect(await fsp.readFile(path.join(dir, "bin/helper.sh"), "utf8")).toBe("x");
  });
});
