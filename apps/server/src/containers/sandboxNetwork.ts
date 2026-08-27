import Docker from "dockerode";

const docker = new Docker();

/** The bridge every sandbox container joins.
 *
 *  Its own module because both the project container and its database need
 *  it, and having the database service import the container manager — which
 *  imports the env service, which needs the database service for
 *  DATABASE_URL — would close a real import cycle. A shared constant and one
 *  idempotent call are all either of them wanted from the other.
 */
export const SANDBOX_NETWORK = "replit-clone-sandbox";

/** Ensures the sandbox network exists. Idempotent. */
export async function ensureNetwork(): Promise<void> {
  const networks = await docker.listNetworks({
    filters: { name: [SANDBOX_NETWORK] },
  });

  if (networks.some((network) => network.Name === SANDBOX_NETWORK)) return;

  await docker.createNetwork({
    Name: SANDBOX_NETWORK,
    Driver: "bridge",
    // Keeps sandboxes off the default bridge, which several unrelated
    // containers on this host also share.
    Internal: false,
  });
}
