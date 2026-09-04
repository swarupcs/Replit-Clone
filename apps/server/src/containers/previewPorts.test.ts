import { beforeEach, describe, expect, it, vi } from "vitest";

/** `readDevcontainer` is the file this is all about, so it is the one thing
 *  stubbed by hand. Everything else in the module is left alone. */
const readDevcontainer = vi.hoisted(() => vi.fn());
vi.mock("./devcontainer.js", async () => ({
  ...(await vi.importActual<typeof import("./devcontainer.js")>(
    "./devcontainer.js",
  )),
  readDevcontainer,
}));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique } },
}));

/** One container, running, with three ports published on loopback. Matches
 *  what `node-express-ts` asks for plus a devcontainer's 4000. */
const inspect = vi.hoisted(() => vi.fn());
const listContainers = vi.hoisted(() => vi.fn());
vi.mock("dockerode", () => ({
  default: class {
    listContainers = listContainers;
    getContainer = () => ({ inspect });
  },
}));

import { declaredPorts, previewablePorts, getPreviewTarget } from "./containerManager.js";
import type { DevcontainerConfig } from "./devcontainer.js";

const TEMPLATE = { devPort: 3000, extraPorts: [5173, 8080] };
const PROJECT = "p1";

/** A config as `readDevcontainer` returns one. Built through a helper because
 *  `source` and `unsupported` are always present and never what these tests are
 *  about — and a partial literal typechecks under vitest, which strips types,
 *  while `tsc` rejects it. */
const config = (forwardPorts: number[]): DevcontainerConfig => ({
  source: ".devcontainer/devcontainer.json",
  unsupported: [],
  forwardPorts,
});

beforeEach(() => {
  vi.clearAllMocks();
  readDevcontainer.mockResolvedValue(null);
  findUnique.mockResolvedValue({ id: PROJECT, template: "node-express-ts" });
  listContainers.mockResolvedValue([
    { Id: "c1", State: "running", Names: [`/rc-project-${PROJECT}`] },
  ]);
  inspect.mockResolvedValue({
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "32771" }],
        "5173/tcp": [{ HostIp: "127.0.0.1", HostPort: "32772" }],
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32773" }],
        "4000/tcp": [{ HostIp: "127.0.0.1", HostPort: "32774" }],
      },
      Networks: { "replit-clone-sandbox": { IPAddress: "172.20.0.5" } },
    },
  });
});

describe("declaredPorts", () => {
  it("is the template's ports when there is no devcontainer", () => {
    expect(declaredPorts(TEMPLATE, null)).toEqual([3000, 5173, 8080]);
  });

  it("adds what a devcontainer forwards", () => {
    expect(declaredPorts(TEMPLATE, config([4000]))).toEqual([
      3000, 5173, 8080, 4000,
    ]);
  });

  /** Docker rejects a duplicate exposed port, so a devcontainer repeating a
   *  port its template already knew about must not produce two. */
  it("does not repeat a port the template already declared", () => {
    expect(declaredPorts(TEMPLATE, config([8080, 4000]))).toEqual([
      3000, 5173, 8080, 4000,
    ]);
  });

  it("survives a template with no extra ports", () => {
    expect(declaredPorts({ devPort: 8000 }, config([9000]))).toEqual([
      8000, 9000,
    ]);
  });
});

describe("previewablePorts", () => {
  it("lists the template's ports", async () => {
    expect(await previewablePorts(PROJECT)).toEqual([3000, 5173, 8080]);
  });

  /** The defect this file exists for: a port declared in devcontainer.json was
   *  exposed and published by the build path, then left out of the list the
   *  editor draws its dropdown from. */
  it("lists a port the devcontainer forwards", async () => {
    readDevcontainer.mockResolvedValue(config([4000]));

    expect(await previewablePorts(PROJECT)).toContain(4000);
  });

  /** Being locked out by the file you are trying to fix is the worst failure
   *  available here, so an unreadable config falls back rather than throwing. */
  it("falls back to the template when the config cannot be read", async () => {
    readDevcontainer.mockRejectedValue(new Error("unparseable"));

    expect(await previewablePorts(PROJECT)).toEqual([3000, 5173, 8080]);
  });
});

describe("getPreviewTarget", () => {
  it("defaults to the template's dev port", async () => {
    expect(await getPreviewTarget(PROJECT)).toBe("http://127.0.0.1:32771");
  });

  it("dials a port the template declares", async () => {
    expect(await getPreviewTarget(PROJECT, 8080)).toBe("http://127.0.0.1:32773");
  });

  /** The other half of the same defect: asking for a forwarded port by hand
   *  was refused, so even a user who knew the number could not reach it. */
  it("dials a port the devcontainer forwards", async () => {
    readDevcontainer.mockResolvedValue(config([4000]));

    expect(await getPreviewTarget(PROJECT, 4000)).toBe("http://127.0.0.1:32774");
  });

  /** Still a whitelist. A port nobody declared is refused whether or not the
   *  container happens to have it open. */
  it("refuses a port nothing declared", async () => {
    expect(await getPreviewTarget(PROJECT, 4000)).toBeUndefined();
  });

  it("refuses a port when the devcontainer forwards a different one", async () => {
    readDevcontainer.mockResolvedValue(config([4000]));

    expect(await getPreviewTarget(PROJECT, 9999)).toBeUndefined();
  });

  it("is undefined when the container is not running", async () => {
    listContainers.mockResolvedValue([]);

    expect(await getPreviewTarget(PROJECT)).toBeUndefined();
  });
});
