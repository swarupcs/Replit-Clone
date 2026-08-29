import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The container behind an always-on deployment.
 *
 *  What is worth testing here is not that a container is created — it is the
 *  handful of ways this one has to differ from a project's container, each of
 *  which is silent when wrong: it must survive its own crash, it must be
 *  invisible to every sweep that reaps or counts project containers, it must
 *  not be reachable from the host except through the proxy, and it must not be
 *  able to exhaust the budget that keeps the editor usable.
 */

const docker = vi.hoisted(() => ({
  createContainer: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    createContainer = docker.createContainer;
    getContainer = docker.getContainer;
    listContainers = docker.listContainers;
  },
}));

const settings = vi.hoisted(() => ({
  DEPLOY_MEMORY_MB: 512,
  DEPLOY_CPUS: 0.5,
  MAX_DEPLOYED_SERVICES: 5,
  SANDBOX_EGRESS_FILTERED: false,
}));

const preview = vi.hoisted<{ mode: "container-ip" | "host-loopback" }>(() => ({
  mode: "container-ip",
}));

vi.mock("../config/env.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: settings,
  get previewTargetMode() {
    return preview.mode;
  },
}));

vi.mock("../utils/projectPaths.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  userForDirectory: vi.fn().mockResolvedValue("1001:1001"),
}));

const {
  DEPLOY_CONTAINER_PREFIX,
  deployContainerName,
  removeService,
  runningServices,
  serviceTarget,
  startService,
  waitForService,
} = await import("./deployContainer.js");

const SPEC = {
  subdomain: "quiet-fern-84f1",
  image: "sandbox-node:latest",
  command: "npm install --omit=dev && node server.js",
  port: 3000,
  root: "/srv/deployments/quiet-fern-84f1",
  projectEnv: ["DATABASE_URL=postgres://example"],
};

function stubCreate() {
  const start = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  docker.createContainer.mockResolvedValue({ id: "svc1", start });
  docker.getContainer.mockReturnValue({
    inspect: vi.fn().mockRejectedValue(new Error("no such container")),
    remove,
  });
  return { start, remove };
}

/** The one call every assertion below reads. */
function created(): {
  Env: string[];
  Cmd: string[];
  name: string;
  HostConfig: Record<string, unknown>;
  ExposedPorts?: Record<string, unknown>;
} {
  const [options] = docker.createContainer.mock.calls[0] as [
    {
      Env: string[];
      Cmd: string[];
      name: string;
      HostConfig: Record<string, unknown>;
      ExposedPorts?: Record<string, unknown>;
    },
  ];
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.MAX_DEPLOYED_SERVICES = 5;
  preview.mode = "container-ip";
  docker.listContainers.mockResolvedValue([]);
});

describe("the container a published service runs in", () => {
  it("is named out of reach of every project-container sweep", () => {
    // The idle reaper, the capacity count and the boot reconciler all select
    // on the `rc-project-` prefix. A published service caught by any of them
    // would be stopped for being idle -- which it always is, since nobody is
    // editing it -- or counted against the budget that exists so a project can
    // be opened. The prefix is what keeps it out of all three.
    expect(deployContainerName("quiet-fern-84f1")).toBe(
      "rc-deploy-quiet-fern-84f1",
    );
    expect(DEPLOY_CONTAINER_PREFIX.startsWith("rc-project")).toBe(false);
  });

  it("restarts itself when the app crashes", async () => {
    // The one place in this codebase that asks Docker to restart anything, and
    // the reason is that nobody is watching this one. Everywhere else a crash
    // happens in front of somebody who can act on it.
    stubCreate();

    await startService(SPEC);

    expect(created().HostConfig["RestartPolicy"]).toEqual({
      Name: "on-failure",
      MaximumRetryCount: 10,
    });
  });

  it("stays stopped when it was stopped deliberately", async () => {
    // `always` would fight `removeService` and bring back a site somebody had
    // just taken offline.
    stubCreate();

    await startService(SPEC);

    expect(
      (created().HostConfig["RestartPolicy"] as { Name: string }).Name,
    ).not.toBe("always");
  });

  it("holds no capabilities and cannot gain any", async () => {
    stubCreate();

    await startService(SPEC);

    expect(created().HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(created().HostConfig["SecurityOpt"]).toEqual(["no-new-privileges"]);
  });

  it("publishes nothing to the host when the server can route to it", async () => {
    // The public origin proxies; a host port would be a second way in that
    // nothing asked for.
    stubCreate();

    await startService(SPEC);

    expect(created().HostConfig["PortBindings"]).toBeUndefined();
    expect(created().ExposedPorts).toBeUndefined();
  });

  it("publishes on loopback only where the host cannot route to containers", async () => {
    // Docker Desktop gives the host no route to a container IP, which is the
    // same reason previews have this mode. Never 0.0.0.0: the deploy origin is
    // the only thing that should be able to reach it.
    preview.mode = "host-loopback";
    stubCreate();

    await startService(SPEC);

    expect(created().HostConfig["PortBindings"]).toEqual({
      "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
    });
  });

  it("mounts the published copy, never the project's own tree", async () => {
    // A published address that changed under its visitors every time its
    // author saved would not be a deployment.
    stubCreate();

    await startService(SPEC);

    expect(created().HostConfig["Binds"]).toEqual([
      "/srv/deployments/quiet-fern-84f1:/home/sandbox/app",
    ]);
  });

  it("carries the project's own environment", async () => {
    // A published app with no DATABASE_URL is a published app that 500s.
    stubCreate();

    await startService(SPEC);

    expect(created().Env).toContain("DATABASE_URL=postgres://example");
    expect(created().Env).toContain("PORT=3000");
    expect(created().Env).toContain("NODE_ENV=production");
  });

  it("lets the project's variables win over the platform's defaults", async () => {
    stubCreate();

    await startService({ ...SPEC, projectEnv: ["NODE_ENV=staging"] });

    const env = created().Env;
    // Last occurrence is the one Docker keeps.
    expect(env.lastIndexOf("NODE_ENV=staging")).toBeGreaterThan(
      env.indexOf("NODE_ENV=production"),
    );
  });

  it("replaces an existing container rather than restarting it", async () => {
    // So a redeploy runs the tree that was just copied, not the previous one.
    const { remove } = stubCreate();

    await startService(SPEC);

    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(docker.createContainer).toHaveBeenCalled();
  });

  it("runs the serve command through a shell, but not a LOGIN shell", async () => {
    // These commands have `&&` in them, so a shell is needed; an argv array
    // would run `npm` with the rest as arguments.
    //
    // `-c` rather than `-lc`, and that is not a detail. A login shell sources
    // /etc/profile, which replaces PATH with the distribution's default and
    // discards whatever the image set. The Go image puts its toolchain on
    // /usr/local/go/bin, so `-lc` made every Go deployment fail with "go: not
    // found" -- five minutes later, when the readiness wait timed out.
    stubCreate();

    await startService(SPEC);

    expect(created().Cmd).toEqual([
      "sh",
      "-c",
      "npm install --omit=dev && node server.js",
    ]);
  });
});

describe("how many may run at once", () => {
  it("refuses one past the host's limit", async () => {
    // A separate budget from MAX_CONCURRENT_CONTAINERS on purpose: counting
    // always-on containers against the interactive limit means enough
    // publishing makes the editor unusable.
    settings.MAX_DEPLOYED_SERVICES = 2;
    docker.listContainers.mockResolvedValue([
      { Names: ["/rc-deploy-one"] },
      { Names: ["/rc-deploy-two"] },
    ]);
    stubCreate();

    await expect(startService(SPEC)).rejects.toThrow(/at that limit/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("does not count a redeploy against its own place", async () => {
    // Otherwise the last deployment the host can hold could never be updated.
    settings.MAX_DEPLOYED_SERVICES = 2;
    docker.listContainers.mockResolvedValue([
      { Names: ["/rc-deploy-one"] },
      { Names: [`/${deployContainerName(SPEC.subdomain)}`] },
    ]);
    stubCreate();

    await expect(startService(SPEC)).resolves.toBeUndefined();
  });
});

describe("where the public origin sends a request", () => {
  it("says nowhere when the container is not running", async () => {
    // Answered as a 503 rather than a 404: the address IS a site, it is the
    // app that is missing. Distinguishing them is safe here because the
    // subdomain already resolved.
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
      remove: vi.fn(),
    });

    await expect(serviceTarget("quiet-fern-84f1", 3000)).resolves.toBeUndefined();
  });

  it("says nowhere when there is no container at all", async () => {
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error("no such container")),
      remove: vi.fn(),
    });

    await expect(serviceTarget("quiet-fern-84f1", 3000)).resolves.toBeUndefined();
  });

  it("addresses the container directly where the host can route to it", async () => {
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        NetworkSettings: {
          Networks: { "replit-clone-sandbox": { IPAddress: "172.25.0.9" } },
        },
      }),
      remove: vi.fn(),
    });

    await expect(serviceTarget("quiet-fern-84f1", 3000)).resolves.toBe(
      "http://172.25.0.9:3000",
    );
  });

  it("uses the published loopback port in host-loopback mode", async () => {
    preview.mode = "host-loopback";
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        NetworkSettings: { Ports: { "3000/tcp": [{ HostPort: "49213" }] } },
      }),
      remove: vi.fn(),
    });

    await expect(serviceTarget("quiet-fern-84f1", 3000)).resolves.toBe(
      "http://127.0.0.1:49213",
    );
  });
});

describe("taking one down", () => {
  it("does not treat a missing container as a failure", async () => {
    // Unpublishing something already unpublished is what clicking twice
    // means, not an error.
    docker.getContainer.mockReturnValue({
      inspect: vi.fn(),
      remove: vi.fn().mockRejectedValue(new Error("No such container")),
    });

    await expect(removeService("quiet-fern-84f1")).resolves.toBeUndefined();
  });
});

describe("what is already up", () => {
  it("reports the subdomains, with the prefix stripped", async () => {
    // The boot reconciler compares this against the LIVE rows to work out
    // what a host restart left behind.
    docker.listContainers.mockResolvedValue([
      { Names: ["/rc-deploy-quiet-fern-84f1"] },
      { Names: ["/rc-deploy-bold-heron-0c11"] },
    ]);

    await expect(runningServices()).resolves.toEqual(
      new Set(["quiet-fern-84f1", "bold-heron-0c11"]),
    );
  });

  it("is empty rather than throwing when Docker cannot be reached", async () => {
    // A daemon that is down must not stop the server booting -- it costs the
    // container features and nothing else, which is the trade made everywhere
    // else at startup.
    docker.listContainers.mockRejectedValue(new Error("daemon down"));

    await expect(runningServices()).resolves.toEqual(new Set());
  });
});

describe("deciding that a deployment is ready", () => {
  /** Listeners created by a test, closed afterwards whatever it did. */
  const open: { close: (cb?: () => void) => void }[] = [];

  afterEach(async () => {
    await Promise.all(
      open.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  /** Points `serviceTarget` at a real local port, as host-loopback mode does. */
  function containerOn(port: number) {
    preview.mode = "host-loopback";
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        NetworkSettings: {
          Ports: { "3000/tcp": [{ HostPort: String(port) }] },
        },
      }),
      remove: vi.fn(),
    });
  }

  async function listen(server: {
    listen: (port: number, host: string, cb: () => void) => void;
    address: () => AddressInfo | string | null;
    close: (cb?: () => void) => void;
  }): Promise<number> {
    open.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  it("is not fooled by a port that accepts and then hangs up", async () => {
    // THE bug this replaced, and it was invisible from every angle but a real
    // deployment. In host-loopback mode the published port belongs to
    // `docker-proxy`, which accepts a connection whether or not anything
    // inside the container is listening and only fails when it tries to
    // forward. A TCP connect therefore succeeded the moment the container was
    // scheduled: every publish reported LIVE within a second, while npm
    // install was still running, and every request to the brand new address
    // died with a socket hang up.
    const port = await listen(
      createServer((socket) => {
        socket.destroy();
      }),
    );
    containerOn(port);

    await expect(waitForService("quiet-fern-84f1", 3000, 2500)).resolves.toBe(
      false,
    );
  });

  it("accepts any HTTP answer, including a 404", async () => {
    // What a published app serves at / is its own business. An API with no
    // index route is a perfectly good app, and refusing to call it deployed
    // would be this platform having an opinion it has no standing to have.
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(404);
        res.end("no index here");
      }),
    );
    containerOn(port);

    await expect(waitForService("quiet-fern-84f1", 3000, 5000)).resolves.toBe(
      true,
    );
  });

  it("accepts a 500, which is a running app with a bug in it", async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(500);
        res.end("boom");
      }),
    );
    containerOn(port);

    await expect(waitForService("quiet-fern-84f1", 3000, 5000)).resolves.toBe(
      true,
    );
  });

  it("gives up at once on a container that has already exited", async () => {
    // Waiting out the rest of a five-minute timeout on a container that has
    // stopped only delays a failure its logs already explain.
    preview.mode = "host-loopback";
    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
      remove: vi.fn(),
    });

    const started = Date.now();
    await expect(waitForService("quiet-fern-84f1", 3000, 30_000)).resolves.toBe(
      false,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
