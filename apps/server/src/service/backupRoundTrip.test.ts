import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A real archive written to a real directory and unpacked back out again.
 *
 *  plan.md §3.3. Everything else in this feature can be tested against mocks;
 *  this cannot, and it is the only test here that is evidence of anything.
 *  §1's standing lesson is that a mock cannot be wrong about a round trip in
 *  any way worth trusting — and a backup nobody has restored is not a backup,
 *  which is the whole reason `restoreService` exists as code rather than as a
 *  paragraph in a runbook.
 */

const root = path.join(os.tmpdir(), `rc-backup-${String(process.pid)}`);
const projectsDir = path.join(root, "projects");
const backupDir = path.join(root, "backups");

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const envMock = vi.hoisted(() => ({
  BACKUP_DIR: "",
  PROJECTS_DIR: "",
  BACKUP_KEEP: 3,
  BACKUP_INTERVAL_HOURS: 24,
}));
vi.mock("../config/env.js", () => ({ env: envMock }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  projectCollaborator: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  scheduledJob: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  projectDatabaseConnection: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

/** The real path helpers, pointed at the temporary tree. `projectRoot` reads
 *  `env.PROJECTS_DIR`, which the mock above supplies. */
vi.mock("../utils/projectPaths.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/projectPaths.js")>(
    "../utils/projectPaths.js",
  );
  return {
    ...actual,
    projectRoot: (id: string) => path.join(envMock.PROJECTS_DIR, id),
    isLocalProject: () => localProject,
  };
});

let localProject = false;

import {
  backupProject,
  listBackups,
  pruneBackups,
  runBackupSweep,
} from "./backupService.js";
import { planRestore, restoreProject, verifyBackup } from "./restoreService.js";

const NOW = new Date("2026-09-09T03:00:00.000Z");

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: PROJECT,
    name: "thing",
    ownerId: "11111111-1111-4111-8111-111111111111",
    template: "node-express",
    envVars: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

async function writeTree(): Promise<void> {
  const dir = path.join(projectsDir, PROJECT);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "react"), { recursive: true });
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });

  await fs.writeFile(path.join(dir, "package.json"), '{"name":"thing"}', "utf8");
  await fs.writeFile(path.join(dir, "src", "server.js"), "console.log(1)\n", "utf8");
  await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n", "utf8");
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await fs.writeFile(
    path.join(dir, "node_modules", "react", "index.js"),
    "module.exports = {}\n",
    "utf8",
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  localProject = false;

  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  envMock.BACKUP_DIR = backupDir;
  envMock.PROJECTS_DIR = projectsDir;
  envMock.BACKUP_KEEP = 3;

  prismaMock.project.findUnique.mockResolvedValue(projectRow());
  prismaMock.project.findMany.mockResolvedValue([{ id: PROJECT }]);
  prismaMock.projectCollaborator.findMany.mockResolvedValue([]);
  prismaMock.scheduledJob.findMany.mockResolvedValue([]);
  prismaMock.projectDatabaseConnection.findMany.mockResolvedValue([]);
  prismaMock.user.findUnique.mockResolvedValue({ id: projectRow().ownerId });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("backing a project up", () => {
  it("writes an archive, a manifest and the rows", async () => {
    await writeTree();

    const manifest = await backupProject(PROJECT);
    expect(manifest).not.toBeNull();

    const directory = path.join(backupDir, PROJECT, String(manifest?.at));
    const entries = await fs.readdir(directory);

    expect(entries.sort()).toEqual(["manifest.json", "project.json", "tree.tar.gz"]);
    expect(manifest?.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.treeBytes).toBeGreaterThan(0);
  });

  it("leaves no .partial archive behind", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const entries = await fs.readdir(
      path.join(backupDir, PROJECT, String(manifest?.at)),
    );

    // A half-written archive carrying a plausible name is worse than a missing
    // one: the pruner counts it and a restore fails partway through.
    expect(entries.some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("skips a project nothing has happened to since the last one", async () => {
    await writeTree();
    expect(await backupProject(PROJECT)).not.toBeNull();

    // Same `updatedAt`. Re-archiving would produce seven identical copies a
    // week and spend a gzip on each.
    expect(await backupProject(PROJECT)).toBeNull();
  });

  it("backs it up again once the project has changed", async () => {
    await writeTree();
    await backupProject(PROJECT);

    prismaMock.project.findUnique.mockResolvedValue(
      projectRow({ updatedAt: new Date(NOW.getTime() + 60_000) }),
    );

    expect(await backupProject(PROJECT)).not.toBeNull();
  });

  it("compares the project's own timestamp, not the clock", async () => {
    await writeTree();
    const first = await backupProject(PROJECT);

    // The manifest records the source's `updatedAt`, not the moment the sweep
    // ran. Comparing against the clock means a server whose time steps forward
    // — an NTP correction, a restored VM — sees every project as unchanged and
    // silently stops backing anything up. Nothing would report that.
    expect(first?.sourceUpdatedAt).toBe(NOW.getTime());
    expect(first?.at).toBeGreaterThan(NOW.getTime());
  });

  it("carries the row when a project has no tree at all", async () => {
    // Two of these are on record (§3.4), and deleting rows is somebody's
    // judgment call rather than a backup's.
    const manifest = await backupProject(PROJECT);

    expect(manifest?.treeSkipped?.reason).toContain("no working tree");
    expect(manifest?.treeSha256).toBeNull();
  });

  it("does not copy the tree of a folder that was already on the host", async () => {
    localProject = true;
    await writeTree();

    const manifest = await backupProject(PROJECT);

    // §10.2's folders. Copying arbitrary host paths into a backup destination
    // is a surprise nobody asked for, and the manifest says so rather than
    // producing an empty project quietly.
    expect(manifest?.treeSkipped?.reason).toContain("already on the host");
    expect(manifest?.treeSkipped?.path).toContain(PROJECT);
  });
});

describe("what an archive carries", () => {
  it("includes .git, which a copy deliberately drops", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const target = path.join(root, "restored");
    envMock.PROJECTS_DIR = target;
    await restoreProject(PROJECT, { at: manifest?.at });

    // The one place this must NOT reuse EXCLUDED_DIRECTORIES. A restore that
    // hands back a tree with no history has lost most of what was there.
    const head = await fs.readFile(
      path.join(target, PROJECT, ".git", "HEAD"),
      "utf8",
    );
    expect(head).toContain("refs/heads/main");
  });

  it("includes dotfiles the export would also carry", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const target = path.join(root, "restored");
    envMock.PROJECTS_DIR = target;
    await restoreProject(PROJECT, { at: manifest?.at });

    expect(await fs.readFile(path.join(target, PROJECT, ".env"), "utf8")).toContain(
      "SECRET=1",
    );
  });

  it("leaves node_modules out", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const target = path.join(root, "restored");
    envMock.PROJECTS_DIR = target;
    await restoreProject(PROJECT, { at: manifest?.at });

    const present = await fs
      .stat(path.join(target, PROJECT, "node_modules"))
      .then(() => true)
      .catch(() => false);

    expect(present).toBe(false);
  });
});

describe("the round trip", () => {
  it("puts every file back with its contents", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const target = path.join(root, "restored");
    envMock.PROJECTS_DIR = target;

    const result = await restoreProject(PROJECT, { at: manifest?.at });

    expect(result.treeRestored).toBe(true);
    expect(result.filesWritten).toBeGreaterThan(0);
    expect(
      await fs.readFile(path.join(target, PROJECT, "src", "server.js"), "utf8"),
    ).toBe("console.log(1)\n");
    expect(
      await fs.readFile(path.join(target, PROJECT, "package.json"), "utf8"),
    ).toBe('{"name":"thing"}');
  });

  it("puts the project row back", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    envMock.PROJECTS_DIR = path.join(root, "restored");
    const result = await restoreProject(PROJECT, { at: manifest?.at });

    expect(result.rowRestored).toBe(true);
    expect(prismaMock.project.upsert).toHaveBeenCalledTimes(1);
  });

  it("revives dates rather than writing ISO strings into date columns", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    envMock.PROJECTS_DIR = path.join(root, "restored");
    await restoreProject(PROJECT, { at: manifest?.at });

    const call = prismaMock.project.upsert.mock.calls[0]?.[0] as {
      create: { createdAt: unknown };
    };

    // JSON turns every Date into a string and nothing turns them back, so
    // without this a restore fails on the first date column with an error that
    // names neither the column nor the reason.
    expect(call.create.createdAt).toBeInstanceOf(Date);
  });

  it("does not restore a row whose owner is not on this server", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);
    prismaMock.user.findUnique.mockResolvedValue(null);

    envMock.PROJECTS_DIR = path.join(root, "restored");
    const result = await restoreProject(PROJECT, { at: manifest?.at });

    // The files are still restored; the row would be one nobody could reach.
    expect(result.treeRestored).toBe(true);
    expect(result.rowRestored).toBe(false);
    expect(result.warnings.join(" ")).toContain("does not exist on this");
  });
});

describe("refusing to destroy anything", () => {
  it("refuses to restore over a tree that is already there", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    // The tree is still where it was.
    await expect(restoreProject(PROJECT, { at: manifest?.at })).rejects.toThrow(
      /already exists/,
    );
  });

  it("moves the existing tree aside rather than deleting it, under --force", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    await fs.writeFile(
      path.join(projectsDir, PROJECT, "src", "server.js"),
      "console.log('newer')\n",
      "utf8",
    );

    const result = await restoreProject(PROJECT, { at: manifest?.at, force: true });

    // A restore is reached for by somebody guessing, on a bad day. If it was
    // the wrong backup, what they replaced is still there.
    expect(result.displaced).not.toBeNull();
    const displaced = await fs.readFile(
      path.join(String(result.displaced), "src", "server.js"),
      "utf8",
    );
    expect(displaced).toContain("newer");
  });
});

describe("verifying", () => {
  it("passes on an archive that has not been touched", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    expect(await verifyBackup(PROJECT, Number(manifest?.at))).toEqual({ ok: true });
  });

  it("fails on one that has been truncated", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const archive = path.join(backupDir, PROJECT, String(manifest?.at), "tree.tar.gz");
    await fs.truncate(archive, 10);

    const result = await verifyBackup(PROJECT, Number(manifest?.at));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("digest mismatch");
  });

  it("refuses to restore an archive that does not verify", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);
    await fs.truncate(
      path.join(backupDir, PROJECT, String(manifest?.at), "tree.tar.gz"),
      10,
    );

    envMock.PROJECTS_DIR = path.join(root, "restored");
    await expect(
      restoreProject(PROJECT, { at: manifest?.at }),
    ).rejects.toThrow(/does not verify/);
  });
});

describe("what a restore would do", () => {
  it("reports the target, the row and the warnings without touching anything", async () => {
    await writeTree();
    const manifest = await backupProject(PROJECT);

    const plan = await planRestore(PROJECT);

    expect(plan.manifest.at).toBe(manifest?.at);
    expect(plan.targetExists).toBe(true);
    expect(plan.rowExists).toBe(true);
    expect(plan.warnings.join(" ")).toContain("SECRET_ENCRYPTION_KEY");

    // Nothing moved.
    expect(
      await fs.readFile(path.join(projectsDir, PROJECT, "package.json"), "utf8"),
    ).toBe('{"name":"thing"}');
  });
});

describe("pruning", () => {
  it("keeps the newest and drops the rest", async () => {
    await writeTree();
    envMock.BACKUP_KEEP = 2;

    for (let i = 0; i < 4; i += 1) {
      // Forced, because this case is about pruning rather than about the skip:
      // four backups of an unchanged project is exactly what the skip exists
      // to prevent, and going through it here would test that instead.
      await backupProject(PROJECT, { force: true });
      // Backups are named by millisecond, so four in the same one would be one.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(await listBackups(PROJECT)).toHaveLength(4);
    expect(await pruneBackups(PROJECT)).toBe(2);

    const left = await listBackups(PROJECT);
    expect(left).toHaveLength(2);
    // Oldest first, so what is left is the tail.
    expect(left[0]?.at).toBeLessThan(Number(left[1]?.at));
  });

  it("counts a directory with no manifest as no backup at all", async () => {
    await writeTree();
    await backupProject(PROJECT);

    // A sweep killed halfway through. The manifest is written last precisely
    // so this directory is ignored rather than restored from.
    await fs.mkdir(path.join(backupDir, PROJECT, "999"), { recursive: true });

    expect(await listBackups(PROJECT)).toHaveLength(1);
  });
});

describe("the sweep", () => {
  it("reports what it did", async () => {
    await writeTree();

    const summary = await runBackupSweep();

    expect(summary.backedUp).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("carries on when one project cannot be backed up", async () => {
    prismaMock.project.findMany.mockResolvedValue([
      { id: PROJECT },
      { id: "not-a-uuid" },
    ]);
    await writeTree();

    const summary = await runBackupSweep();

    // The run where one tree is unreadable is exactly the run where the others
    // matter most.
    expect(summary.backedUp).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("does nothing at all when no destination is configured", async () => {
    envMock.BACKUP_DIR = "";
    await writeTree();

    expect(await runBackupSweep()).toEqual({
      backedUp: 0,
      skipped: 0,
      failed: 0,
      pruned: 0,
    });
  });
});
