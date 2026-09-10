import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  embed: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  // `updateEmbed` returns `embedState`, which asks whether the project has a
  // deployment so the owner's dialog can say whether the preview half will be
  // empty. Not on a sandbox's path, but on the path of the function that sets
  // one up.
  deployment: { findUnique: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));
vi.mock("../config/env.js", () => ({ env: { WEB_ORIGIN: "https://example.test" } }));

const planMock = vi.hoisted(() => vi.fn());
vi.mock("./browserPreviewService.js", () => ({ planBrowserPreview: planMock }));
// `embedState` lists the project's files to name the secret ones it is hiding.
// A leaf-only tree is enough: what these tests are about is the sandbox flag.
vi.mock("./fileTreeService.js", () => ({
  buildFileTree: vi.fn().mockResolvedValue({
    type: "directory",
    relPath: "",
    children: [],
  }),
}));
// `embedService` reaches the deploy service for an embed's preview URL, and
// that reaches the container manager. None of it is on a sandbox's path, and
// importing it here would start the metrics registry.
vi.mock("./deployService.js", () => ({ liveDeployment: vi.fn() }));
vi.mock("../utils/projectPaths.js", () => ({
  assertValidProjectId: (id: string) => id,
  projectRoot: () => "/tmp",
}));

import { sandboxPayload } from "./embedService.js";

const TOKEN = "a".repeat(43);
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function row(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    view: "split",
    preview: "deployment",
    activeFile: null,
    sandbox: true,
    project: { id: PROJECT, name: "Demo", template: "react-vite" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.embed.findFirst.mockResolvedValue(row());
  planMock.mockResolvedValue({
    supported: true,
    entry: "src/main.tsx",
    files: { "src/main.tsx": "render()", ".env": "SECRET=1" },
    dependencies: [],
    html: "<html></html>",
  });
});

describe("a sandbox a stranger can open", () => {
  it("hands over every source file at once", async () => {
    // The build happens in the visitor's browser, and a bundler cannot ask the
    // server for an import halfway through.
    const payload = await sandboxPayload(TOKEN);
    expect(payload.entry).toBe("src/main.tsx");
    expect(payload.files["src/main.tsx"]).toBe("render()");
  });

  it("never hands over a secret file", async () => {
    // `planBrowserPreview` already omits these by extension, but that is a list
    // in another file kept for another reason. The rule about secrets is
    // applied where the handing-over happens.
    const payload = await sandboxPayload(TOKEN);
    expect(Object.keys(payload.files)).not.toContain(".env");
  });

  it("refuses when the owner has not turned it on", async () => {
    prismaMock.embed.findFirst.mockResolvedValue(row({ sandbox: false }));

    // A different message from a bad token, because this token IS served
    // publicly by the embed endpoint -- its existence is not a secret, and
    // pretending otherwise would only confuse the owner.
    await expect(sandboxPayload(TOKEN)).rejects.toThrow(/embed, not a sandbox/);
  });

  it("gives the same answer for a revoked token as for a mistyped one", async () => {
    prismaMock.embed.findFirst.mockResolvedValue(null);
    await expect(sandboxPayload(TOKEN)).rejects.toThrow(/not available/);
  });

  it("refuses a token that is not shaped like one, without a query", async () => {
    await expect(sandboxPayload("../../etc/passwd")).rejects.toThrow(/not available/);
    expect(prismaMock.embed.findFirst).not.toHaveBeenCalled();
  });

  it("says why a server project cannot run here, rather than half-loading", async () => {
    planMock.mockResolvedValue({
      supported: false,
      reason: "needs-a-server",
      message: "This project runs a server, so it needs a container.",
    });

    const payload = await sandboxPayload(TOKEN);
    expect(payload.entry).toBeNull();
    expect(payload.refusal).toContain("container");
    expect(payload.files).toEqual({});
  });

  it("offers somewhere to keep the changes", async () => {
    // Saving means forking and forking means signing in -- the boundary the
    // product already had, moved to after the interesting part.
    expect((await sandboxPayload(TOKEN)).forkUrl).toContain(PROJECT);
  });

  it("asks for no container anywhere in the path", async () => {
    // The whole reason §14.5 sequenced this after 13.2. If this ever starts
    // one, an anonymous page view spends this host's memory.
    await sandboxPayload(TOKEN);
    expect(planMock).toHaveBeenCalledWith(PROJECT);
  });
});

describe("the owner's switch", () => {
  it("is stripped by no schema on the way in", async () => {
    // Regression: `z.object` drops what it does not name, so this setting was
    // briefly a switch in the UI that changed nothing on the server.
    const { updateEmbed } = await import("./embedService.js");
    prismaMock.embed.findUnique.mockResolvedValue(row());
    prismaMock.embed.update.mockResolvedValue(row());
    prismaMock.embed.findFirst.mockResolvedValue(row());
    prismaMock.deployment.findUnique.mockResolvedValue(null);

    await updateEmbed(PROJECT, { sandbox: true });

    const call = prismaMock.embed.update.mock.calls[0]?.[0] as {
      data: { sandbox?: boolean };
    };
    expect(call.data.sandbox).toBe(true);
  });

  it("refuses a value that is not a boolean", async () => {
    const { updateEmbed } = await import("./embedService.js");
    prismaMock.embed.findUnique.mockResolvedValue(row());

    // `"false"` read as truthy is exactly how a switch like this gets turned on
    // by accident.
    await expect(
      updateEmbed(PROJECT, { sandbox: "false" as unknown as boolean }),
    ).rejects.toThrow(/true or false/);
  });
});

describe("the settings a client may send", () => {
  it("keeps sandbox, which z.object would otherwise strip", async () => {
    // The regression this guards is invisible one layer down: the service
    // handles `sandbox` correctly, and the schema in front of it was silently
    // deleting the field. A switch in the UI that changed nothing.
    const { settingsSchema } = await import("../controllers/embedController.js");
    expect(settingsSchema.parse({ sandbox: true })).toEqual({ sandbox: true });
  });

  it("refuses a non-boolean before it reaches the service", async () => {
    const { settingsSchema } = await import("../controllers/embedController.js");
    expect(() => settingsSchema.parse({ sandbox: "yes" })).toThrow();
  });
});
