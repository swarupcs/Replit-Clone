import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { listBackups } from "../service/backupService.js";
import {
  planRestore,
  restoreProject,
  verifyBackup,
} from "../service/restoreService.js";

/** The command somebody runs on a bad day. plan.md §3.3, §14.2.
 *
 *  A script rather than an endpoint, and the reason is the case it exists for.
 *  The question this answers is "the host died", so the machine it runs on is
 *  usually a NEW one, restoring from a mount, before anybody has signed in —
 *  there is no session to authorise an endpoint with and no dashboard to press
 *  a button on. A route would also put "replace this project's working tree"
 *  behind an HTTP request, which is a thing this codebase has been careful not
 *  to have.
 *
 *  Everything destructive is opt-in and named:
 *
 *    node dist/scripts/restore.js --list <projectId>
 *    node dist/scripts/restore.js --verify <projectId> [--at <ms>]
 *    node dist/scripts/restore.js --plan <projectId> [--at <ms>]
 *    node dist/scripts/restore.js <projectId> [--at <ms>] [--force]
 *
 *  In development, `pnpm --filter @replit-clone/server exec tsx
 *  src/scripts/restore.ts ...` runs the same thing without a build.
 */

interface Args {
  projectId?: string;
  at?: number;
  force: boolean;
  skipVerify: boolean;
  mode: "restore" | "list" | "verify" | "plan";
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, skipVerify: false, mode: "restore" };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--force") args.force = true;
    else if (token === "--skip-verify") args.skipVerify = true;
    else if (token === "--at") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value)) {
        throw new Error("--at takes the backup's timestamp, in milliseconds");
      }
      args.at = value;
      i += 1;
    } else if (token === "--list" || token === "--verify" || token === "--plan") {
      args.mode = token.slice(2) as Args["mode"];
    } else if (token !== undefined && !token.startsWith("--")) {
      args.projectId = token;
    }
  }

  return args;
}

function report(lines: string[]): void {
  // Straight to stdout rather than through the logger: this is a command a
  // person is reading the output of, not a server writing a log somebody will
  // grep later.
  for (const line of lines) process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!env.BACKUP_DIR) {
    throw new Error(
      "BACKUP_DIR is not set, so this server does not know where backups are. " +
        "Set it to the directory they were written to.",
    );
  }

  if (!args.projectId) {
    report([
      "Usage:",
      "  restore --list <projectId>              what backups exist",
      "  restore --verify <projectId> [--at ms]  check an archive's digest",
      "  restore --plan <projectId> [--at ms]    what a restore would do",
      "  restore <projectId> [--at ms] [--force] do it",
      "",
      `Reading from ${env.BACKUP_DIR}`,
    ]);
    return;
  }

  if (args.mode === "list") {
    const backups = await listBackups(args.projectId);
    if (backups.length === 0) {
      report([`No backups of ${args.projectId} under ${env.BACKUP_DIR}.`]);
      return;
    }

    report([
      `${String(backups.length)} backup(s) of ${args.projectId}:`,
      ...backups.map((backup) => {
        const when = new Date(backup.at).toISOString();
        const size = backup.treeSkipped
          ? `no tree — ${backup.treeSkipped.reason}`
          : `${(backup.treeBytes / 1024 / 1024).toFixed(1)} MB`;
        return `  ${String(backup.at)}  ${when}  ${size}`;
      }),
    ]);
    return;
  }

  if (args.mode === "verify") {
    const backups = await listBackups(args.projectId);
    const target = args.at ?? backups.at(-1)?.at;
    if (target === undefined) {
      throw new Error(`No backups of ${args.projectId}.`);
    }

    const result = await verifyBackup(args.projectId, target);
    report([
      result.ok
        ? `OK — ${args.projectId} at ${String(target)} matches its digest.`
        : `DAMAGED — ${result.reason ?? "unknown"}`,
    ]);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.mode === "plan") {
    const plan = await planRestore(args.projectId, args.at);
    report([
      `Would restore ${plan.manifest.projectId} from ${new Date(plan.manifest.at).toISOString()}`,
      `  tree     -> ${plan.target}${plan.targetExists ? " (exists)" : ""}`,
      `  row      -> ${plan.rowExists ? "overwritten" : "created"}`,
      `  contents -> ${String(plan.manifest.rows.collaborators)} collaborator(s), ` +
        `${String(plan.manifest.rows.scheduledJobs)} job(s), ` +
        `${String(plan.manifest.rows.databaseConnections)} database connection(s)`,
      "",
      ...plan.warnings.map((warning) => `  ! ${warning}`),
    ]);
    return;
  }

  const result = await restoreProject(args.projectId, {
    at: args.at,
    force: args.force,
    skipVerify: args.skipVerify,
  });

  report([
    `Restored ${result.projectId} from ${new Date(result.at).toISOString()}`,
    `  tree: ${result.treeRestored ? `${String(result.filesWritten)} file(s)` : "not restored"}`,
    `  row:  ${result.rowRestored ? "restored" : "not restored"}`,
    ...(result.displaced ? [`  the tree that was there is at ${result.displaced}`] : []),
    "",
    ...result.warnings.map((warning) => `  ! ${warning}`),
  ]);
}

/** Whether this module was run, rather than imported.
 *
 *  Compared exactly rather than by substring: a test file named
 *  `restore.test.ts` matches "restore", so a looser check would have importing
 *  the parser to test it perform an actual restore — which on a developer's
 *  machine is a working tree moved aside.
 */
const runDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
