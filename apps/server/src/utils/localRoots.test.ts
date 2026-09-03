import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** What may be opened as a folder.
 *
 *  This is the one check standing between "open a folder" and "any signed-in
 *  user may bind-mount any path this process can reach into a container that
 *  runs their code as a user who can write it". So these tests are against a
 *  real filesystem rather than a mocked one: the interesting cases are symlinks
 *  and `..`, and a mock of `realpath` would be a test of the mock's opinion
 *  about symlinks rather than of the rule.
 */

let sandbox: string;
let allowed: string;
let outside: string;
let projectsRoot: string;

// Built before the module under test is imported, because the allowlist is
// resolved from `env` at module load. The paths therefore have to exist first.
beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "rc-local-roots-"));
  // Through `realpath` because macOS puts /var behind a symlink to /private/var
  // and every comparison below is against a resolved path.
  sandbox = await fs.realpath(sandbox);

  allowed = path.join(sandbox, "allowed");
  outside = path.join(sandbox, "outside");
  projectsRoot = path.join(sandbox, "server-projects");

  await fs.mkdir(path.join(allowed, "a-project"), { recursive: true });
  await fs.mkdir(path.join(allowed, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(outside, "secrets"), { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.writeFile(path.join(allowed, "a-file"), "not a directory");

  // The escape: a name inside the allowed root whose contents are not.
  await fs.symlink(outside, path.join(allowed, "escape-hatch"));

  // A server-owned tree that happens to sit under an allowed root, which is
  // the case the PROJECTS_ROOT check exists for.
  await fs.mkdir(path.join(projectsRoot, "owned"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** The module reads the allowlist once, at import. Each block that needs a
 *  different configuration therefore re-imports it with the env it wants. */
async function loadWith(roots: string[], projects = projectsRoot) {
  vi.resetModules();
  process.env["LOCAL_FOLDER_ROOTS"] = roots.join(",");
  process.env["PROJECTS_DIR"] = projects;
  return import("./localRoots.js");
}

describe("when no roots are configured", () => {
  it("is off, and off means refuse rather than allow", async () => {
    const { localFoldersEnabled, resolveLocalFolder } = await loadWith([]);

    expect(localFoldersEnabled()).toBe(false);

    // The direction that matters. An empty allowlist elsewhere in this codebase
    // means "no ceiling" (EGRESS_ALLOW_DOMAINS); here it must mean the
    // opposite, because the thing being allowed is the host's filesystem.
    await expect(resolveLocalFolder(allowed)).rejects.toMatchObject({
      code: "LOCAL_FOLDERS_DISABLED",
    });
  });
});

describe("resolving a folder against the allowlist", () => {
  it("accepts a directory beneath a configured root", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(resolveLocalFolder(path.join(allowed, "a-project"))).resolves.toBe(
      path.join(allowed, "a-project"),
    );
  });

  it("accepts the root itself", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(resolveLocalFolder(allowed)).resolves.toBe(allowed);
  });

  it("refuses a directory outside every root", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(resolveLocalFolder(outside)).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });

  it("refuses a traversal out of a root", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(
      resolveLocalFolder(path.join(allowed, "..", "outside")),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("refuses a symlink that points out of a root", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    // Inside the root by name, the whole of `outside` by content. This is the
    // reason the check is against `realpath`'s answer and not against the
    // string that was passed in.
    await expect(
      resolveLocalFolder(path.join(allowed, "escape-hatch")),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("refuses a sibling whose name merely starts with a root's", async () => {
    const { resolveLocalFolder } = await loadWith([path.join(sandbox, "allow")]);

    // `/allowed` is not under `/allow`, and a bare `startsWith` would say it is.
    // The directory `/allow` does not exist, so this would resolve against the
    // allowlist and then fail -- what is asserted is that it fails on the
    // allowlist, not on the missing parent.
    await expect(resolveLocalFolder(allowed)).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });

  it("refuses a relative path", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(resolveLocalFolder("allowed/a-project")).rejects.toMatchObject({
      code: "PATH_NOT_ABSOLUTE",
    });
  });

  it("refuses a path with a null byte", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    // Before anything touches the filesystem: a NUL truncates inside libuv, so
    // a check that ran after an fs call would have already opened something.
    await expect(
      resolveLocalFolder(`${allowed}\0/../../etc`),
    ).rejects.toThrow(/null byte/i);
  });

  it("refuses a file", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(
      resolveLocalFolder(path.join(allowed, "a-file")),
    ).rejects.toMatchObject({ code: "NOT_A_DIRECTORY" });
  });

  it("refuses something that is not there", async () => {
    const { resolveLocalFolder } = await loadWith([allowed]);

    await expect(
      resolveLocalFolder(path.join(allowed, "no-such-folder")),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
  });

  it("refuses a tree this server already owns", async () => {
    // The awkward configuration: an operator names a root that happens to
    // contain PROJECTS_ROOT. Allowed by the allowlist, refused anyway, because
    // two rows over one directory disagree about who may delete it.
    const { resolveLocalFolder } = await loadWith([sandbox], projectsRoot);

    await expect(
      resolveLocalFolder(path.join(projectsRoot, "owned")),
    ).rejects.toMatchObject({ code: "PATH_IS_SERVER_OWNED" });
  });

  it("accepts a folder under the second of several roots", async () => {
    const { resolveLocalFolder } = await loadWith([
      path.join(sandbox, "nowhere"),
      allowed,
    ]);

    await expect(resolveLocalFolder(path.join(allowed, "a-project"))).resolves.toBe(
      path.join(allowed, "a-project"),
    );
  });
});

describe("browsing", () => {
  it("lists directories, not files", async () => {
    const { listLocalFolders } = await loadWith([allowed]);

    const names = (await listLocalFolders(allowed)).map((entry) => entry.name);

    expect(names).toContain("a-project");
    expect(names).not.toContain("a-file");
  });

  it("hides dotfiles", async () => {
    const { listLocalFolders } = await loadWith([allowed]);

    const names = (await listLocalFolders(allowed)).map((entry) => entry.name);

    expect(names).not.toContain(".hidden");
  });

  it("goes through the same check, so it is not a listing of the host", async () => {
    const { listLocalFolders } = await loadWith([allowed]);

    await expect(listLocalFolders(outside)).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
    });
  });
});
