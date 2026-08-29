import Docker from "dockerode";
import { env, previewTargetMode } from "../config/env.js";

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

/** The sandbox network is not the one the configuration describes.
 *
 *  Its own type because boot treats it differently from every other Docker
 *  failure. A daemon that is down or slow costs the container features and
 *  nothing else -- the server still serves the editor, and that is the right
 *  trade. This is not that. Every case that raises it leaves the deployment
 *  quietly wrong about itself: either sandboxes have unrestricted outbound
 *  access while the configuration says they have none, or no preview can
 *  work at all and each one reports that nothing is running while the dev
 *  server is demonstrably up. Both are far harder to diagnose from the
 *  symptom than from a message at boot.
 */
export class SandboxNetworkMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxNetworkMismatch";
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

async function sandboxIsInternal(): Promise<boolean> {
  const details = (await docker.getNetwork(SANDBOX_NETWORK).inspect()) as {
    Internal?: boolean;
  };
  return details.Internal === true;
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

  assertPreviewsCanWork(filtered);

  if (await networkExists(SANDBOX_NETWORK)) {
    await assertNetworkMatchesConfig(filtered);
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

/** Refuses the one configuration in which no preview can ever load.
 *
 *  Docker publishes a container port by installing a DNAT rule on the host,
 *  and it does not do that for a container whose only network is internal.
 *  The request is accepted and silently produces no binding at all --
 *  `HostConfig.PortBindings` holds what was asked for and
 *  `NetworkSettings.Ports` comes back empty. So in host-loopback mode, where
 *  the preview proxy reaches a project through its published port on
 *  127.0.0.1, turning the egress control on removes the only route it has.
 *
 *  Nothing about that is visible from the symptom. The container runs, the
 *  dev server compiles and prints its banner in the terminal, and every
 *  preview reports that nothing is running -- which reads as a bug in the
 *  project rather than as a network setting two layers away.
 *
 *  The two are not reconcilable, only choosable between: publishing a port
 *  off an internal network is not something Docker can be persuaded to do.
 *  So this names the choice instead of quietly making it.
 */
function assertPreviewsCanWork(filtered: boolean): void {
  if (!filtered || previewTargetMode !== "host-loopback") return;

  throw new SandboxNetworkMismatch(
    "SANDBOX_EGRESS_FILTERED is on and previews resolve in host-loopback " +
      "mode. These cannot both hold: Docker does not publish ports for a " +
      "container on an internal network, so every preview would report that " +
      "nothing is running however healthy the dev server is. Either set " +
      "SANDBOX_EGRESS_FILTERED=false (the usual choice when running this " +
      "server directly on your own machine), or give the server a route to " +
      "container IPs and set PREVIEW_TARGET_MODE=container-ip -- which on a " +
      "host whose Docker keeps container IPs to itself means running the " +
      "server in a container, as docker-compose does.",
  );
}

/** Refuses to run when the network on the host is not the one configured.
 *
 *  `Internal` cannot be changed on an existing network, so flipping
 *  SANDBOX_EGRESS_FILTERED does nothing whatever to a network that is
 *  already there -- and the resulting state is quiet in both directions:
 *
 *  - Turned ON, network still permissive: every sandbox keeps full outbound
 *    access while the deployment believes it has none.
 *  - Turned OFF, network still internal: package installs fail with network
 *    errors, and in host-loopback mode no preview can bind a port.
 *
 *  Neither is something an operator will trace back to a network they last
 *  thought about weeks ago, so both refuse with the command that fixes them.
 */
async function assertNetworkMatchesConfig(filtered: boolean): Promise<void> {
  const internal = await sandboxIsInternal();
  if (internal === filtered) return;

  const problem = filtered
    ? "SANDBOX_EGRESS_FILTERED is on, but the network already exists and is " +
      "not internal, so sandboxes would still have unrestricted outbound " +
      "access"
    : "SANDBOX_EGRESS_FILTERED is off, but the network already exists and " +
      "IS internal, so sandboxes have no outbound access and previews " +
      "cannot publish a port";

  throw new SandboxNetworkMismatch(
    `${problem}. Docker cannot change this on an existing network. Stop the ` +
      "running project containers and remove it " +
      `("docker network rm ${SANDBOX_NETWORK}"); it will be recreated ` +
      "correctly on the next boot.",
  );
}
