import { describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ BACKUP_DIR: "", PROJECTS_DIR: "projects" }));
vi.mock("../config/env.js", () => ({ env: envMock }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

import { assertBackupDestination, backupsEnabled } from "./backupService.js";
import { parseArgs } from "../scripts/restore.js";

function withDirs(backup: string, projects: string): void {
  envMock.BACKUP_DIR = backup;
  envMock.PROJECTS_DIR = projects;
}

/** plan.md §3.3. The check exists because the wrong destination does not fail
 *  — it works, every night, until the day it is needed. */
describe("where backups are allowed to go", () => {
  it("is off when no destination is named", () => {
    withDirs("", "/data/projects");
    expect(backupsEnabled()).toBe(false);
    expect(() => {
      assertBackupDestination();
    }).not.toThrow();
  });

  it("accepts a directory on another path", () => {
    withDirs("/mnt/backups", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).not.toThrow();
  });

  it("refuses a destination inside PROJECTS_DIR", () => {
    // The failure this prevents: a year of nightly backups sitting on the one
    // disk whose loss is the only thing they were for.
    withDirs("/data/projects/.backups", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).toThrow(/same tree/);
  });

  it("refuses PROJECTS_DIR inside the destination", () => {
    // The same mistake the other way round, and just as fatal.
    withDirs("/data", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).toThrow(/same tree/);
  });

  it("refuses a destination that IS PROJECTS_DIR", () => {
    withDirs("/data/projects", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).toThrow(/same tree/);
  });

  it("is not fooled by a relative path spelling the same place", () => {
    withDirs("/data/projects/../projects/backups", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).toThrow(/same tree/);
  });

  it("allows a sibling whose name merely starts the same", () => {
    // `/data/projects-backup` is not inside `/data/projects`, and a check
    // written with `startsWith` would say it was.
    withDirs("/data/projects-backup", "/data/projects");
    expect(() => {
      assertBackupDestination();
    }).not.toThrow();
  });
});

/** The command somebody runs on a bad day, so every destructive thing it can
 *  do has to be spelled out rather than defaulted into. */
describe("the restore command's arguments", () => {
  it("restores by default, and destroys nothing by default", () => {
    const args = parseArgs(["abc"]);
    expect(args.mode).toBe("restore");
    expect(args.projectId).toBe("abc");
    expect(args.force).toBe(false);
    expect(args.skipVerify).toBe(false);
  });

  it("reads the three read-only modes", () => {
    expect(parseArgs(["--list", "abc"]).mode).toBe("list");
    expect(parseArgs(["--verify", "abc"]).mode).toBe("verify");
    expect(parseArgs(["--plan", "abc"]).mode).toBe("plan");
  });

  it("takes a backup's timestamp", () => {
    expect(parseArgs(["abc", "--at", "1757386800000"]).at).toBe(1757386800000);
  });

  it("refuses a timestamp that is not one", () => {
    // Rather than silently restoring the newest, which is not what was asked
    // for and is unrecoverable once it has happened.
    expect(() => parseArgs(["abc", "--at", "yesterday"])).toThrow(/milliseconds/);
  });

  it("does not read a flag as the project id", () => {
    expect(parseArgs(["--force", "abc"]).projectId).toBe("abc");
    expect(parseArgs(["--force", "abc"]).force).toBe(true);
  });

  it("has no project id when none was given", () => {
    expect(parseArgs(["--list"]).projectId).toBeUndefined();
  });
});
