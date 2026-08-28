import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Docker-side wiring of the egress control.
 *
 *  Three things can go wrong here that no amount of testing the policy would
 *  catch, and all three are silent: the sandbox network keeps its route out,
 *  the gateway is never attached to the network it is supposed to serve, or
 *  the whole thing is off and the deployment believes it is on. Each has a
 *  test below.
 */

const docker = vi.hoisted(() => ({
  listNetworks: vi.fn(),
  createNetwork: vi.fn().mockResolvedValue({}),
  getNetwork: vi.fn(),
  createContainer: vi.fn(),
  getContainer: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    listNetworks = docker.listNetworks;
    createNetwork = docker.createNetwork;
    getNetwork = docker.getNetwork;
    createContainer = docker.createContainer;
    getContainer = docker.getContainer;
  },
}));

const settings = vi.hoisted(() => ({
  SANDBOX_EGRESS_FILTERED: false,
  EGRESS_IMAGE: "sandbox-egress:latest",
  EGRESS_ALLOW_DOMAINS: [] as string[],
  EGRESS_ALLOW_PORTS: [80, 443, 9418],
}));

// Partial: the logger reads `isProduction` from the same module at import
// time, so replacing the whole thing takes the logger down with it.
vi.mock("../config/env.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: settings,
}));

const { ensureNetwork, SANDBOX_NETWORK, EGRESS_NETWORK } = await import(
  "./sandboxNetwork.js"
);
const { ensureEgressGateway, proxyEnv, EGRESS_CONTAINER } = await import(
  "./egressGateway.js"
);

/** A gateway container that starts cleanly, and the connect() spy that says
 *  whether it was put on the sandbox network. */
function stubDocker(options: { existing?: unknown } = {}) {
  const start = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);

  docker.createContainer.mockResolvedValue({ id: "gw1", start });
  docker.getNetwork.mockReturnValue({ connect, inspect: vi.fn() });
  docker.getContainer.mockReturnValue({
    inspect: options.existing
      ? vi.fn().mockResolvedValue(options.existing)
      : vi.fn().mockRejectedValue(new Error("no such container")),
    remove,
  });

  return { start, connect, remove };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.SANDBOX_EGRESS_FILTERED = false;
  settings.EGRESS_ALLOW_DOMAINS = [];
  docker.listNetworks.mockResolvedValue([]);
  docker.createNetwork.mockResolvedValue({});
});

describe("the sandbox network", () => {
  it("is left routable when filtering is off", async () => {
    // The behaviour every existing deployment has. Changing it silently on
    // upgrade would break every package install with no stated cause.
    await ensureNetwork();

    expect(docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: SANDBOX_NETWORK, Internal: false }),
    );
  });

  it("has no route off it at all when filtering is on", async () => {
    // This one line IS the control. Not a filter on the route — the route.
    settings.SANDBOX_EGRESS_FILTERED = true;

    await ensureNetwork();

    expect(docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: SANDBOX_NETWORK, Internal: true }),
    );
  });

  it("creates the gateway's own outbound network alongside it", async () => {
    settings.SANDBOX_EGRESS_FILTERED = true;

    await ensureNetwork();

    expect(docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: EGRESS_NETWORK, Internal: false }),
    );
  });

  it("refuses to boot when the control is on and an old permissive network exists", async () => {
    // The failure this exists for is quiet and bad. Docker ignores `Internal`
    // on a network that already exists, so an operator who turns the setting
    // on after the fact gets a server that believes it is filtering and is
    // not. Refusing is worth more than running while wrong about itself.
    settings.SANDBOX_EGRESS_FILTERED = true;
    docker.listNetworks.mockResolvedValue([{ Name: SANDBOX_NETWORK }]);
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Internal: false }),
    });

    await expect(ensureNetwork()).rejects.toThrow(/not internal/);
  });

  it("names the command that fixes it", async () => {
    // A refusal an operator cannot act on is an outage rather than a guard.
    settings.SANDBOX_EGRESS_FILTERED = true;
    docker.listNetworks.mockResolvedValue([{ Name: SANDBOX_NETWORK }]);
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Internal: false }),
    });

    await expect(ensureNetwork()).rejects.toThrow(/docker network rm/);
  });

  it("is satisfied by an existing network that is already internal", async () => {
    settings.SANDBOX_EGRESS_FILTERED = true;
    docker.listNetworks.mockResolvedValue([{ Name: SANDBOX_NETWORK }]);
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Internal: true }),
    });

    await expect(ensureNetwork()).resolves.toBeUndefined();
  });
});

describe("the gateway container", () => {
  it("is not started at all when filtering is off", async () => {
    await ensureEgressGateway();

    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("joins BOTH networks", async () => {
    // The whole point of it. On the outbound network only, it is a container
    // with internet access that no sandbox can reach; on the sandbox network
    // only, it is a proxy with nowhere to proxy to.
    settings.SANDBOX_EGRESS_FILTERED = true;
    const { connect } = stubDocker();

    await ensureEgressGateway();

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        HostConfig: expect.objectContaining({ NetworkMode: EGRESS_NETWORK }),
      }),
    );
    expect(docker.getNetwork).toHaveBeenCalledWith(SANDBOX_NETWORK);
    expect(connect).toHaveBeenCalledWith({ Container: "gw1" });
  });

  it("is attached to the sandbox network before it starts", async () => {
    // A gateway that starts listening on a network it has not joined is a
    // gateway sandboxes cannot reach for as long as the race lasts.
    settings.SANDBOX_EGRESS_FILTERED = true;
    const order: string[] = [];
    const start = vi.fn().mockImplementation(() => {
      order.push("start");
      return Promise.resolve();
    });
    const connect = vi.fn().mockImplementation(() => {
      order.push("connect");
      return Promise.resolve();
    });
    docker.createContainer.mockResolvedValue({ id: "gw1", start });
    docker.getNetwork.mockReturnValue({ connect, inspect: vi.fn() });
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error("none")),
    });

    await ensureEgressGateway();

    expect(order).toEqual(["connect", "start"]);
  });

  it("holds no capabilities and no mounts", async () => {
    settings.SANDBOX_EGRESS_FILTERED = true;
    stubDocker();

    await ensureEgressGateway();

    const [options] = docker.createContainer.mock.calls[0] as [
      { HostConfig: Record<string, unknown> },
    ];
    expect(options.HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(options.HostConfig["SecurityOpt"]).toEqual(["no-new-privileges"]);
    // Never published: reachable from sandboxes and from nothing else, which
    // is the right blast radius for a thing that dials out for untrusted code.
    expect(options.HostConfig["PortBindings"]).toBeUndefined();
  });

  it("passes the deployment's allowlist through to the proxy", async () => {
    settings.SANDBOX_EGRESS_FILTERED = true;
    settings.EGRESS_ALLOW_DOMAINS = ["npmjs.org", "github.com"];
    stubDocker();

    await ensureEgressGateway();

    const [options] = docker.createContainer.mock.calls[0] as [
      { Env: string[] },
    ];
    expect(options.Env).toContain("EGRESS_ALLOW_DOMAINS=npmjs.org,github.com");
  });

  it("leaves a running gateway alone", async () => {
    // Restarting it would cut every in-flight download from every project on
    // the host, to achieve nothing.
    settings.SANDBOX_EGRESS_FILTERED = true;
    stubDocker({ existing: { State: { Running: true } } });

    await ensureEgressGateway();

    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("replaces a stopped one rather than restarting it", async () => {
    // So it comes back with the current image and the current allowlist,
    // rather than the ones it was created with.
    settings.SANDBOX_EGRESS_FILTERED = true;
    const { remove } = stubDocker({ existing: { State: { Running: false } } });

    await ensureEgressGateway();

    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(docker.createContainer).toHaveBeenCalled();
  });
});

describe("what project containers are told", () => {
  it("says nothing when there is no gateway to point at", () => {
    expect(proxyEnv()).toEqual([]);
  });

  it("points every proxy variable at the gateway, in both cases", () => {
    // The convention is lowercase, a long tail of tools reads only the
    // uppercase form, and curl reads only the lowercase one for HTTP.
    settings.SANDBOX_EGRESS_FILTERED = true;

    const vars = proxyEnv();

    for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      expect(vars).toContain(`${name}=http://${EGRESS_CONTAINER}:3128`);
    }
  });

  it("keeps container-to-container traffic off the proxy", () => {
    // A dev server sending its own localhost requests through the gateway
    // would have them refused as private addresses — correctly, and
    // uselessly.
    settings.SANDBOX_EGRESS_FILTERED = true;

    expect(proxyEnv().some((line) => line.startsWith("NO_PROXY="))).toBe(true);
  });
});
