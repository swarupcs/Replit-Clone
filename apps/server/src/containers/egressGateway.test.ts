import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Docker-side wiring of the egress control.
 *
 *  Four things can go wrong here that no amount of testing the policy would
 *  catch, and every one of them is silent: the sandbox network keeps its
 *  route out, the gateway is never attached to the network it is supposed to
 *  serve, the whole thing is off and the deployment believes it is on, or the
 *  network is internal in a deployment that reaches previews through
 *  published ports -- which an internal network does not have, so every
 *  preview goes dark while the dev server runs fine. Each has a test below.
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

/** How previews are resolved, which decides whether an internal network is
 *  survivable. A getter rather than a value because both answers need testing
 *  and the module is imported once for the whole file. */
const preview = vi.hoisted<{ mode: "container-ip" | "host-loopback" }>(() => ({
  mode: "container-ip",
}));

// Partial: the logger reads `isProduction` from the same module at import
// time, so replacing the whole thing takes the logger down with it.
vi.mock("../config/env.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: settings,
  get previewTargetMode() {
    return preview.mode;
  },
}));

const { ensureNetwork, SANDBOX_NETWORK, EGRESS_NETWORK, SandboxNetworkMismatch } =
  await import("./sandboxNetwork.js");
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
  preview.mode = "container-ip";
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
    // A type of its own, because boot must EXIT on this one rather than
    // logging it and serving on -- which is what it used to do.
    await expect(ensureNetwork()).rejects.toBeInstanceOf(
      SandboxNetworkMismatch,
    );
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

  it("refuses to boot when the control is off and the network is still internal", async () => {
    // The mirror, and the one that actually bit: turning the setting back off
    // leaves the internal network in place, Docker publishes no ports for a
    // container on it, and every preview reports that nothing is running
    // while the dev server is demonstrably up in the terminal beside it.
    settings.SANDBOX_EGRESS_FILTERED = false;
    docker.listNetworks.mockResolvedValue([{ Name: SANDBOX_NETWORK }]);
    docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Internal: true }),
    });

    await expect(ensureNetwork()).rejects.toThrow(/IS internal/);
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

  it("refuses filtering in host-loopback mode, before touching Docker at all", async () => {
    // Docker installs a DNAT rule to publish a port and does not do it for a
    // container on an internal network -- it accepts the request and produces
    // no binding. So the preview proxy, which dials 127.0.0.1:<published>,
    // has no route at all, and every preview reports nothing running however
    // healthy the dev server is. The two settings are choosable between, not
    // reconcilable, so boot names the choice rather than making it quietly.
    settings.SANDBOX_EGRESS_FILTERED = true;
    preview.mode = "host-loopback";

    await expect(ensureNetwork()).rejects.toBeInstanceOf(
      SandboxNetworkMismatch,
    );
    // Refused on the configuration alone: no network is created, so a first
    // boot cannot leave a half-built topology behind to explain later.
    expect(docker.createNetwork).not.toHaveBeenCalled();
  });

  it("says which settings to change rather than only what is wrong", async () => {
    settings.SANDBOX_EGRESS_FILTERED = true;
    preview.mode = "host-loopback";

    await expect(ensureNetwork()).rejects.toThrow(
      /SANDBOX_EGRESS_FILTERED=false/,
    );
    await expect(ensureNetwork()).rejects.toThrow(
      /PREVIEW_TARGET_MODE=container-ip/,
    );
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
      remove: vi.fn().mockResolvedValue(undefined),
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

  it("clears the name even when the leftover cannot be inspected", async () => {
    // The 409 this replaced. `existing()` reports "no such container" for any
    // inspect failure, but a half-created container from an interrupted boot
    // still HOLDS the name -- so trusting inspect meant createContainer
    // failing on a conflict every boot until someone removed it by hand.
    settings.SANDBOX_EGRESS_FILTERED = true;
    const remove = vi.fn().mockResolvedValue(undefined);
    docker.createContainer.mockResolvedValue({
      id: "gw1",
      start: vi.fn().mockResolvedValue(undefined),
    });
    docker.getNetwork.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn(),
    });
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error("no such container")),
      remove,
    });

    await ensureEgressGateway();

    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(docker.createContainer).toHaveBeenCalled();
  });

  it("does not treat a missing container as a failure", async () => {
    // The ordinary first boot: nothing to remove, and the remove must not
    // take the gateway down with it.
    settings.SANDBOX_EGRESS_FILTERED = true;
    docker.createContainer.mockResolvedValue({
      id: "gw1",
      start: vi.fn().mockResolvedValue(undefined),
    });
    docker.getNetwork.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn(),
    });
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error("none")),
      remove: vi.fn().mockRejectedValue(new Error("No such container")),
    });

    await expect(ensureEgressGateway()).resolves.toBeUndefined();
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
