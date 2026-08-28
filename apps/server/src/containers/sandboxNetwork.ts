import Docker from "dockerode";
import { env } from "../config/env.js";

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

/** The bridge the egress gateway uses to reach the outside world.
 *
 *  A second network rather than the default one so the gateway's outbound
 *  side is a thing this platform created and can reason about, rather than
 *  whatever else happens to share the host's default bridge.
 */
export const EGRESS_NETWORK = "replit-clone-egress";

/** A control the operator asked for that is not, in fact, in effect.
 *
 *  Its own type because boot treats it differently from every other Docker
 *  failure. A daemon that is down or slow costs the container features and
 *  nothing else -- the server still serves the editor, and that is the right
 *  trade. This is not that: it means sandboxes are running with unrestricted
 *  outbound access while the configuration says they are not, and booting
 *  past it leaves the deployment wrong about itself in the one direction that
 *  matters.
 */
export class EgressControlUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressControlUnavailable";
  }
}

/** Whether the sandbox bridge is cut off from everything but the gateway.
 *
 *  This is the entire egress control, and it is worth being precise about why
 *  a boolean on a network is the whole of it.
 *
 *  Until this existed the sandbox bridge was an ordinary Docker network with
 *  NAT, which meant a project container could reach the internet — fine, an
 *  `npm install` needs to — and ALSO the host's LAN, the cloud instance
 *  metadata endpoint that hands out credentials to anything that asks, other
 *  containers on the host, and in the compose deployment the platform's own
 *  API server. Nothing in the product needed any of that, and the one thing
 *  that did need the internet is exactly the thing most likely to be hostile:
 *  a package install running arbitrary lifecycle scripts.
 *
 *  `Internal: true` removes the route. Not a filter on it — the route. A
 *  container on this bridge can reach other containers on this bridge and
 *  nothing else, so the gateway (`egressGateway.ts`) becomes the only path
 *  out, and hostile code cannot opt out of a proxy it has no alternative to.
 *
 *  Off by default for now, because turning it on requires the gateway image
 *  to be built and existing deployments would otherwise lose package installs
 *  on upgrade. `SANDBOX_EGRESS_FILTERED=true` is the opt-in.
 */
export function egressFiltered(): boolean {
  return env.SANDBOX_EGRESS_FILTERED;
}

async function networkExists(name: string): Promise<boolean> {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  return networks.some((network) => network.Name === name);
}

/** Ensures the sandbox network exists, and the egress network with it.
 *
 *  Idempotent, but NOT self-correcting: an existing network's `Internal` flag
 *  cannot be changed, so a deployment that ran unfiltered and then turns the
 *  setting on keeps its permissive bridge until the network is recreated.
 *  Saying so is the honest option — silently recreating it would disconnect
 *  every running container, and silently doing nothing would leave an
 *  operator believing a control is on when it is not.
 */
export async function ensureNetwork(): Promise<void> {
  const filtered = egressFiltered();

  if (await networkExists(SANDBOX_NETWORK)) {
    if (filtered) await assertSandboxIsInternal();
  } else {
    await docker.createNetwork({
      Name: SANDBOX_NETWORK,
      Driver: "bridge",
      // Keeps sandboxes off the default bridge, which several unrelated
      // containers on this host also share. When filtering is on this also
      // removes the route off the bridge entirely — see `egressFiltered`.
      Internal: filtered,
    });
  }

  if (filtered && !(await networkExists(EGRESS_NETWORK))) {
    await docker.createNetwork({
      Name: EGRESS_NETWORK,
      Driver: "bridge",
      // The gateway's outbound side. Ordinary on purpose.
      Internal: false,
    });
  }
}

/** Refuses to run with a control that is configured on and not in effect.
 *
 *  The failure mode this exists for is quiet and bad: an operator sets
 *  `SANDBOX_EGRESS_FILTERED=true`, the network already existed from before,
 *  Docker ignores the flag on an existing network, and every sandbox keeps
 *  full outbound access while the deployment believes otherwise. A refusal at
 *  boot with the command to fix it is worth more than a running server that
 *  is wrong about itself.
 */
async function assertSandboxIsInternal(): Promise<void> {
  const details = (await docker.getNetwork(SANDBOX_NETWORK).inspect()) as {
    Internal?: boolean;
  };

  if (details.Internal) return;

  throw new EgressControlUnavailable(
    `SANDBOX_EGRESS_FILTERED is on, but the "${SANDBOX_NETWORK}" network ` +
      "already exists and is not internal, so sandboxes would still have " +
      "unrestricted outbound access. Docker cannot change this on an " +
      "existing network. Stop the running project containers and remove it " +
      `("docker network rm ${SANDBOX_NETWORK}"); it will be recreated ` +
      "correctly on the next boot.",
  );
}
