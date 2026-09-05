import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** What a devcontainer's `mounts` may reach.
 *
 *  The most dangerous input in the file, and dangerous in a way none of the
 *  others are: `image` is checked against an allowlist and `postCreateCommand`
 *  runs inside a container that has dropped every capability, but a mount
 *  reaches OUT of the sandbox — and it is asked for by a file in the
 *  repository rather than by the person at the keyboard. Clone a project, open
 *  it, and without confinement its config has mounted whatever it named.
 *
 *  Run against the real filesystem, with real symlinks, because the whole
 *  point of the `realpath` step is that a path can be inside the allowed root
 *  by name and be somewhere else by content. A mock cannot be wrong about that
 *  in any way worth trusting.
 */

let allowed: string;
let outside: string;
let projects: string;

/** Set before the module is imported: the roots are resolved once at startup,
 *  which is the property being relied on. */
const roots = vi.hoisted(() => ({ value: [] as string[], projects: "" }));

vi.mock("../config/env.js", () => ({
  get DEVCONTAINER_MOUNT_ROOTS() {
    return roots.value;
  },
  get PROJECTS_ROOT() {
    return roots.projects;
  },
  env: {},
}));

vi.mock("./containerManager.js", () => ({ MOUNT_POINT: "/home/sandbox/app" }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveMounts, mountsConfigured } = await import(
  "./devcontainerMounts.js"
);

function ask(over: Partial<Parameters<typeof resolveMounts>[0][number]> = {}) {
  return {
    type: "bind",
    source: allowed,
    target: "/data",
    readOnly: false,
    ...over,
  };
}

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rc-mounts-"));
  // realpath because macOS puts the temp dir behind /private, and the whole
  // check compares resolved paths.
  const real = await fs.realpath(base);

  allowed = path.join(real, "allowed");
  outside = path.join(real, "outside");
  projects = path.join(real, "allowed", "projects");

  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
  await fs.writeFile(path.join(real, "a-file"), "not a directory");
});

afterAll(async () => {
  await fs.rm(path.dirname(allowed), { recursive: true, force: true });
});

beforeEach(() => {
  roots.value = [allowed];
  roots.projects = projects;
});

describe("whether mounts are possible at all", () => {
  /** An operator who has not named a root has not opted in, and the safe
   *  reading of silence is off — `localRoots.ts` makes the same choice for the
   *  same reason. */
  it("refuses everything when no root is configured", async () => {
    roots.value = [];

    const result = await resolveMounts([ask()]);

    expect(mountsConfigured()).toBe(false);
    expect(result.mounts).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/DEVCONTAINER_MOUNT_ROOTS/);
  });

  it("allows one inside a configured root", async () => {
    const result = await resolveMounts([ask()]);

    expect(result.refused).toEqual([]);
    expect(result.mounts[0]?.bind).toBe(`${allowed}:/data`);
  });

  it("marks a read-only mount as read-only to Docker", async () => {
    const result = await resolveMounts([ask({ readOnly: true })]);

    expect(result.mounts[0]?.bind).toBe(`${allowed}:/data:ro`);
  });
});

describe("what it refuses", () => {
  it("refuses a path outside every root", async () => {
    const result = await resolveMounts([ask({ source: outside })]);

    expect(result.mounts).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/outside the directories/);
  });

  /** The interesting attack. A link inside the allowed root is within it by
   *  name and is somewhere else entirely by content, so the allowlist has to
   *  be checked against what `realpath` returns rather than what was asked
   *  for. */
  it("refuses a symlink that escapes the root it sits in", async () => {
    const escape = path.join(allowed, "escape-hatch");
    try {
      await fs.symlink(outside, escape);
    } catch {
      // Windows without developer mode. The rule is the same; this machine
      // cannot express the attack.
      return;
    }

    const result = await resolveMounts([ask({ source: escape })]);

    expect(result.mounts).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/outside the directories/);
    await fs.rm(escape, { force: true });
  });

  /** Refused even though it is inside a named root: a project tree has an
   *  owner and rules about who may delete it, and a second path to it answers
   *  to neither. `resolveLocalFolder` refuses the same thing for the same
   *  reason. */
  it("refuses the server's own project trees", async () => {
    const result = await resolveMounts([ask({ source: projects })]);

    expect(result.mounts).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/project tree this server owns/);
  });

  it("refuses a source that is not a directory", async () => {
    const result = await resolveMounts([
      ask({ source: path.join(path.dirname(allowed), "a-file") }),
    ]);

    expect(result.refused[0]?.reason).toMatch(/not a directory/);
  });

  it("refuses a source that does not exist", async () => {
    const result = await resolveMounts([
      ask({ source: path.join(allowed, "nope") }),
    ]);

    expect(result.refused[0]?.reason).toMatch(/no directory at/);
  });

  it("refuses a relative source", async () => {
    const result = await resolveMounts([ask({ source: "../../etc" })]);

    expect(result.refused[0]?.reason).toMatch(/absolute/);
  });

  /** A NUL truncates the path inside libuv, so a naive comparison can pass on
   *  one string and open another. */
  it("refuses a path with a null byte", async () => {
    const result = await resolveMounts([ask({ source: `${allowed}\0/../..` })]);

    expect(result.refused[0]?.reason).toMatch(/null byte/);
  });

  /** A named volume is shared state between whatever mounts it, which on a
   *  deployment with more than one account is a channel between them. */
  it("refuses anything that is not a bind", async () => {
    const result = await resolveMounts([ask({ type: "volume" })]);

    expect(result.refused[0]?.reason).toMatch(/type=bind/);
  });

  /** The workspace is already mounted, and a second mount over it would
   *  either shadow it or race the bind that created it. */
  it("refuses a target inside the workspace", async () => {
    const result = await resolveMounts([
      ask({ target: "/home/sandbox/app/data" }),
    ]);

    expect(result.refused[0]?.reason).toMatch(/inside the workspace/);
  });

  it("refuses the workspace itself", async () => {
    const result = await resolveMounts([ask({ target: "/home/sandbox/app" })]);

    expect(result.refused[0]?.reason).toMatch(/inside the workspace/);
  });

  /** `/home/user-backup` must not pass a prefix test against `/home/user`. */
  it("does not treat a sibling with a shared prefix as inside the root", async () => {
    const sibling = `${allowed}-backup`;
    await fs.mkdir(sibling, { recursive: true });

    const result = await resolveMounts([ask({ source: sibling })]);

    expect(result.mounts).toEqual([]);
    await fs.rm(sibling, { recursive: true, force: true });
  });
});

describe("one refusal among several", () => {
  /** Being locked out by the file you are trying to fix is the failure the
   *  whole devcontainer path is built to avoid. A mount that cannot be
   *  honoured leaves the others honoured and the project open. */
  it("keeps the mounts that passed", async () => {
    const result = await resolveMounts([
      ask({ target: "/one" }),
      ask({ source: outside, target: "/two" }),
      ask({ target: "/three" }),
    ]);

    expect(result.mounts.map((mount) => mount.target)).toEqual([
      "/one",
      "/three",
    ]);
    expect(result.refused).toHaveLength(1);
  });
});
