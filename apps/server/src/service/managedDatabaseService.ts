import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { prisma } from "../lib/prisma.js";
import { open, seal } from "../lib/secretBox.js";
import { logger } from "../lib/logger.js";
import { execCapture } from "../containers/execCapture.js";
import { SANDBOX_NETWORK, ensureNetwork } from "../containers/sandboxNetwork.js";

const docker = new Docker();
import { assertFeature } from "./entitlementService.js";

/** Prefix for a project's database container. Deliberately a sibling of
 *  `rc-project-` rather than a suffix on it, so the quota counters can tell
 *  the two apart while still counting both. */
export const DB_CONTAINER_PREFIX = "rc-db-";
const VOLUME_PREFIX = "rc-dbdata-";

const IMAGE = "postgres:17-alpine";

/** How long to wait for a fresh database to accept connections.
 *
 *  Polled rather than slept through: `pg_isready` answers as soon as it is
 *  true, and a fixed sleep is either too short on a loaded host or wasted
 *  time on an idle one. `containers/devServerProbe.ts` is the shape. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 400;

export interface ManagedDatabaseInfo {
  engine: string;
  databaseName: string;
  /** True once the container is up and answering. */
  running: boolean;
}

export function dbContainerName(projectId: string): string {
  return `${DB_CONTAINER_PREFIX}${projectId}`;
}

function volumeName(projectId: string): string {
  return `${VOLUME_PREFIX}${projectId}`;
}

/** A password nobody types, so it can be as unpleasant as it likes.
 *
 *  base64url rather than hex: same entropy in fewer characters, and no
 *  characters that need escaping inside a connection string. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

async function findContainer(projectId: string) {
  const containers = await docker
    .listContainers({ all: true, filters: { name: [dbContainerName(projectId)] } })
    .catch(() => []);

  const match = containers.find((info) =>
    info.Names.some((name) => name === `/${dbContainerName(projectId)}`),
  );
  return match ? docker.getContainer(match.Id) : null;
}

/** Waits until the database answers, rather than assuming it does. */
async function waitUntilReady(container: Docker.Container): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await execCapture(container, [
      "pg_isready",
      "-U",
      "app",
      "-q",
    ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));

    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new Error("The database did not become ready in time.");
}

/** Provisions a database for a project, or returns the one it already has. */
export async function provision(projectId: string): Promise<ManagedDatabaseInfo> {
  const existing = await prisma.managedDatabase.findUnique({ where: { projectId } });

  // Checked on the way in, not on `start`: a plan that lapses leaves the
  // database somebody already has, and its data, exactly where they are.
  if (!existing) await assertFeature(projectId, "managedDatabases");

  const record =
    existing ??
    (await prisma.managedDatabase.create({
      data: {
        projectId,
        engine: "postgres",
        passwordCipher: seal(generatePassword()),
        databaseName: "app",
        volumeName: volumeName(projectId),
      },
    }));

  await start(projectId);

  return {
    engine: record.engine,
    databaseName: record.databaseName,
    running: true,
  };
}

/** Starts the database container, creating it if this is the first time. */
export async function start(projectId: string): Promise<void> {
  const record = await prisma.managedDatabase.findUnique({ where: { projectId } });
  if (!record) return;

  const existing = await findContainer(projectId);
  if (existing) {
    const info = await existing.inspect();
    if (info.State.Running) return;
    await existing.start();
    await waitUntilReady(existing);
    return;
  }

  await ensureNetwork();

  let password: string;
  try {
    password = open(record.passwordCipher);
  } catch {
    // A key rotation. The data is still on the volume but nothing can reach
    // it, so say so rather than starting a container with a password that
    // will not match what initialised the volume.
    throw new Error(
      "This database's password could not be read. Remove the database and provision a new one.",
    );
  }

  const container = await docker.createContainer({
    Image: IMAGE,
    name: dbContainerName(projectId),
    Env: [
      // In `Env`, never in argv: /proc makes a process's arguments readable
      // by anything else in the container, which is why the git token is
      // passed this way too.
      `POSTGRES_PASSWORD=${password}`,
      "POSTGRES_USER=app",
      `POSTGRES_DB=${record.databaseName}`,
    ],
    HostConfig: {
      // Publishes nothing to the host, exactly as project containers do. The
      // only thing that needs to reach it is on the sandbox network.
      NetworkMode: SANDBOX_NETWORK,
      Binds: [`${record.volumeName}:/var/lib/postgresql/data`],
      RestartPolicy: { Name: "no" },
      Memory: 256 * 1024 * 1024,
    },
  });

  await container.start();
  await waitUntilReady(container);

  logger.info("managed database started", { projectId });
}

/** Stops the container but keeps the volume, so the data survives. */
export async function stop(projectId: string): Promise<void> {
  const container = await findContainer(projectId);
  if (!container) return;
  await container.stop({ t: 5 }).catch(() => undefined);
  await container.remove({ force: true }).catch(() => undefined);
}

/** Removes the database, its container and its data.
 *
 *  The volume goes too. `deployService.unpublish` learned this lesson about
 *  published files outliving the row that pointed at them; a database volume
 *  is the same mistake with more disk attached to it.
 */
export async function destroy(projectId: string): Promise<void> {
  const record = await prisma.managedDatabase.findUnique({ where: { projectId } });
  await stop(projectId);

  if (record) {
    await docker
      .getVolume(record.volumeName)
      .remove({ force: true })
      .catch(() => undefined);
  }

  await prisma.managedDatabase.delete({ where: { projectId } }).catch(() => ({}));
}

/** The connection string for a project's own container to use.
 *
 *  Reachable only from the sandbox network, by container name — which is why
 *  nothing is published to the host and why this is safe to inject. */
export async function connectionUrl(projectId: string): Promise<string | null> {
  const record = await prisma.managedDatabase.findUnique({ where: { projectId } });
  if (!record) return null;

  let password: string;
  try {
    password = open(record.passwordCipher);
  } catch {
    return null;
  }

  return `postgresql://app:${password}@${dbContainerName(projectId)}:5432/${record.databaseName}`;
}

/** Environment for the project's container.
 *
 *  Injected through the same path project env vars already take, so it lands
 *  in the run environment and NOT in a file in the user's tree — where it
 *  would be committed, exported, and listed in the file panel. */
export async function databaseEnv(
  projectId: string,
): Promise<Record<string, string>> {
  const url = await connectionUrl(projectId);
  return url ? { DATABASE_URL: url } : {};
}

export async function describe(
  projectId: string,
): Promise<ManagedDatabaseInfo | null> {
  const record = await prisma.managedDatabase.findUnique({ where: { projectId } });
  if (!record) return null;

  const container = await findContainer(projectId);
  const running = container ? (await container.inspect()).State.Running : false;

  return { engine: record.engine, databaseName: record.databaseName, running };
}
