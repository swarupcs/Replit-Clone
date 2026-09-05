import fs from "node:fs/promises";
import path from "node:path";
import { DEVCONTAINER_MOUNT_ROOTS, PROJECTS_ROOT } from "../config/env.js";
import { MOUNT_POINT } from "./containerManager.js";
import { logger } from "../lib/logger.js";

/** Turning a devcontainer's `mounts` into bind mounts Docker will accept.
 *
 *  This is the most dangerous input in the whole devcontainer file, and it is
 *  dangerous in a way none of the others are: `image` is checked against an
 *  allowlist, `postCreateCommand` runs inside a container that has already
 *  dropped every capability — but a mount reaches OUT of the sandbox, and it
 *  is asked for by a file in the repository rather than by the person at the
 *  keyboard. Clone somebody's project, open it, and without confinement their
 *  `devcontainer.json` has mounted whatever it named. `/var/run/docker.sock`
 *  is a path like any other, and a container that can reach it owns the host.
 *
 *  So the same three-step shape as `resolveLocalFolder`, whose reasoning
 *  applies here with more force: shape before touching the disk, `realpath`
 *  before the allowlist so a symlink cannot be inside the root by name and the
 *  whole filesystem by content, and the server's own project tree refused even
 *  when an operator has named a root above it.
 *
 *  Refusals are collected rather than thrown. A mount that cannot be honoured
 *  must not stop the project opening — being locked out by the file you are
 *  trying to fix is the failure `devcontainerFor` already exists to avoid —
 *  so the container starts without it and the editor is told why.
 */

/** One mount as the spec writes it, before it has been checked. */
export interface RequestedMount {
  type: string;
  source: string;
  target: string;
  readOnly: boolean;
}

/** A mount that passed, in the `Binds` form Docker takes. */
export interface ResolvedMount {
  bind: string;
  source: string;
  target: string;
}

export interface MountResolution {
  mounts: ResolvedMount[];
  /** Why each refused mount was refused, for the editor to show beside the
   *  unsupported keys. Never thrown: see above. */
  refused: { source: string; reason: string }[];
}

/** True when `candidate` is `root` or sits beneath it.
 *
 *  The `root + sep` clause is `resolveLocalFolder`'s, for its reason: without
 *  it `/home/user-backup` passes a prefix test against `/home/user`.
 */
function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** The same rule for a path INSIDE the container, which is always POSIX.
 *
 *  `within` above uses `path.sep`, which is correct for a host path and wrong
 *  for a target: on a Windows host it is a backslash, so `/home/sandbox/app`
 *  plus a separator never matched `/home/sandbox/app/data` and a mount over
 *  the workspace was accepted. The two look like one rule and are two, because
 *  the host's separator and the container's are not the same character.
 */
function withinPosix(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.posix.sep);
}

/** Whether this deployment permits any mount at all. */
export function mountsConfigured(): boolean {
  return DEVCONTAINER_MOUNT_ROOTS.length > 0;
}

/** Checks one requested mount, returning it or the reason it was refused. */
async function check(
  requested: RequestedMount,
): Promise<{ ok: ResolvedMount } | { reason: string }> {
  // Bind only. A named volume is not obviously unsafe, but it is shared state
  // between whatever mounts it — which on a deployment with more than one
  // account is a channel between them, and at n=1 is a feature nobody has
  // asked for. Refused with a reason rather than silently dropped.
  if (requested.type !== "bind") {
    return {
      reason: `Only "type=bind" mounts are supported here, not "${requested.type}".`,
    };
  }

  if (requested.source.includes("\0") || requested.target.includes("\0")) {
    return { reason: "A path containing a null byte is not a path." };
  }

  if (!path.isAbsolute(requested.source)) {
    return {
      reason:
        `"${requested.source}" is not an absolute path. A mount source must ` +
        "name a directory on the machine running this server.",
    };
  }

  if (!path.posix.isAbsolute(requested.target)) {
    return { reason: `"${requested.target}" must be an absolute path.` };
  }

  // The project's own tree is already mounted here, and a second mount over it
  // would either shadow the workspace or race the bind that created it.
  if (withinPosix(requested.target, MOUNT_POINT)) {
    return {
      reason:
        `"${requested.target}" is inside the workspace, which is already ` +
        "mounted. Choose a target outside it.",
    };
  }

  if (!mountsConfigured()) {
    return {
      reason:
        "This deployment mounts nothing but the project. Set " +
        "DEVCONTAINER_MOUNT_ROOTS to the directories it may mount.",
    };
  }

  // Through symlinks, so what is checked below is the directory this actually
  // reaches rather than the name it was reached by.
  let resolved: string;
  try {
    resolved = await fs.realpath(path.resolve(requested.source));
  } catch {
    return { reason: `There is no directory at "${requested.source}".` };
  }

  const stats = await fs.stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return { reason: `"${requested.source}" is not a directory.` };
  }

  if (!DEVCONTAINER_MOUNT_ROOTS.some((root) => within(resolved, root))) {
    return {
      reason:
        `"${requested.source}" is outside the directories this deployment ` +
        "may mount.",
    };
  }

  // Refused even when an operator has named a root above it, for
  // `resolveLocalFolder`'s reason: a project's tree has an owner and rules
  // about who may delete it, and a second path to it answers to neither.
  if (within(resolved, PROJECTS_ROOT)) {
    return {
      reason: `"${requested.source}" is a project tree this server owns.`,
    };
  }

  return {
    ok: {
      source: resolved,
      target: requested.target,
      bind: `${resolved}:${requested.target}${requested.readOnly ? ":ro" : ""}`,
    },
  };
}

/** Checks every requested mount. Order is preserved so Docker sees them in the
 *  order the file asked for, which is what decides nesting. */
export async function resolveMounts(
  requested: RequestedMount[],
): Promise<MountResolution> {
  const mounts: ResolvedMount[] = [];
  const refused: { source: string; reason: string }[] = [];

  for (const entry of requested) {
    const result = await check(entry);
    if ("ok" in result) mounts.push(result.ok);
    else refused.push({ source: entry.source, reason: result.reason });
  }

  if (refused.length > 0) {
    logger.info("devcontainer mounts refused", { count: refused.length });
  }

  return { mounts, refused };
}
