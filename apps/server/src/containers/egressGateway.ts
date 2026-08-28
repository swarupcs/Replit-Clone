import Docker from "dockerode";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { EGRESS_NETWORK, SANDBOX_NETWORK, egressFiltered } from "./sandboxNetwork.js";

const docker = new Docker();

/** The container name, and the hostname sandboxes resolve.
 *
 *  Docker's embedded DNS answers container names on a user-defined network,
 *  so this doubles as the proxy's address without anything having to discover
 *  an IP that changes on every restart.
 */
export const EGRESS_CONTAINER = "rc-egress";

/** The port the gateway listens on, inside the sandbox network only.
 *
 *  Never published to the host. The gateway is reachable from sandboxes and
 *  from nothing else, which is the correct blast radius for a service whose
 *  whole job is to make outbound connections for untrusted code.
 */
const EGRESS_PORT = 3128;

/** What a project container is told, so well-behaved tools find the way out.
 *
 *  Every one of these is a convenience, not a control — the control is that
 *  the sandbox bridge has no other route. They are set because an `npm
 *  install` that respects `HTTPS_PROXY` succeeds and one that does not fails
 *  confusingly, and the difference between a secure platform and an unusable
 *  one is often just telling the honest majority where the door is.
 *
 *  Both cases of each name: the convention is lowercase, but a long tail of
 *  tools reads only the uppercase form, and `curl` famously reads only the
 *  lowercase one for HTTP.
 */
export function proxyEnv(): string[] {
  if (!egressFiltered()) return [];

  const url = `http://${EGRESS_CONTAINER}:${String(EGRESS_PORT)}`;

  return [
    `HTTP_PROXY=${url}`,
    `http_proxy=${url}`,
    `HTTPS_PROXY=${url}`,
    `https_proxy=${url}`,
    // The preview proxy reaches project containers over this same bridge, and
    // a dev server that sent its own localhost requests through the gateway
    // would have them refused as private addresses — correctly, and
    // uselessly. Container-to-container names stay direct.
    "NO_PROXY=localhost,127.0.0.1,::1,.localhost",
    "no_proxy=localhost,127.0.0.1,::1,.localhost",
  ];
}

async function existing(): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(EGRESS_CONTAINER).inspect();
  } catch {
    return null;
  }
}

/** Brings the gateway up, and makes sure it is on both networks.
 *
 *  Called at boot rather than lazily on the first container start: a project
 *  whose install fails because the gateway had not been created yet looks
 *  exactly like a project whose install is broken, and the difference costs
 *  somebody an afternoon.
 *
 *  Idempotent. A gateway that already runs is left alone — restarting it
 *  would cut every in-flight download from every project on the host.
 */
export async function ensureEgressGateway(): Promise<void> {
  if (!egressFiltered()) return;

  const current = await existing();

  if (current?.State.Running) {
    logger.info("egress gateway already running", { name: EGRESS_CONTAINER });
    return;
  }

  // Present but stopped: remove rather than start, so it comes back with the
  // current image and the current allowlist rather than the one it was
  // created with.
  if (current) {
    await docker.getContainer(EGRESS_CONTAINER).remove({ force: true });
  }

  const container = await docker.createContainer({
    Image: env.EGRESS_IMAGE,
    name: EGRESS_CONTAINER,
    Env: [
      `EGRESS_PORT=${String(EGRESS_PORT)}`,
      `EGRESS_ALLOW_DOMAINS=${env.EGRESS_ALLOW_DOMAINS.join(",")}`,
      `EGRESS_ALLOW_PORTS=${env.EGRESS_ALLOW_PORTS.join(",")}`,
    ],
    HostConfig: {
      // Modest: this forwards bytes and holds no state. A gateway that can be
      // pushed into swapping the host is a denial of service against every
      // project at once.
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      PidsLimit: 128,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // The outbound side. The sandbox side is attached below, because
      // `createContainer` takes only one network in `NetworkMode` and a
      // second must be connected afterwards.
      NetworkMode: EGRESS_NETWORK,
      // Restarted by us at boot, and never mid-flight; see above.
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await docker.getNetwork(SANDBOX_NETWORK).connect({ Container: container.id });
  await container.start();

  logger.info("egress gateway started", {
    name: EGRESS_CONTAINER,
    image: env.EGRESS_IMAGE,
    allowDomains: env.EGRESS_ALLOW_DOMAINS.length || "any public",
  });
}
