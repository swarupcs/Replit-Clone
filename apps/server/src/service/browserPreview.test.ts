import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const roots = vi.hoisted(() => ({ current: "" }));
vi.mock("../utils/projectPaths.js", () => ({
  projectRoot: () => roots.current,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({ project: { findUnique: vi.fn() } }));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../templates/registry.js", () => ({
  getTemplate: (id: string) => {
    if (id === "gone") throw new Error("no such template");
    return { id };
  },
}));

import { bareImports, planBrowserPreview, isPreviewableTemplate } from "./browserPreviewService.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const made: string[] = [];

async function project(
  template: string,
  files: Record<string, string>,
): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-bp-"));
  made.push(root);
  roots.current = root;
  prismaMock.project.findUnique.mockResolvedValue({ template });

  for (const [relPath, body] of Object.entries(files)) {
    const absolute = path.join(root, relPath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, body);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const root of made.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("which projects a browser can preview", () => {
  it("takes a front-end project and finds its entry", async () => {
    await project("react-vite", {
      "src/main.tsx": "import App from './App'",
      "src/App.tsx": "export default () => null",
      "index.html": "<html></html>",
    });

    const plan = await planBrowserPreview(PROJECT);
    expect(plan.supported).toBe(true);
    expect(plan.entry).toBe("src/main.tsx");
    expect(plan.html).toBe("<html></html>");
  });

  it("refuses a server project permanently, and says so", async () => {
    // Getting this wrong in the permissive direction gives the reader a blank
    // page and the conclusion that the project is broken.
    await project("node-express", { "index.js": "require('express')" });

    const plan = await planBrowserPreview(PROJECT);
    expect(plan.reason).toBe("needs-a-server");
    expect(plan.message).toContain("container");
  });

  it("refuses a template it has never heard of", async () => {
    // An allowlist, not a deny-list: a new template is far likelier to be
    // another kind of server than another front end.
    await project("brand-new-thing", { "src/main.js": "" });
    expect((await planBrowserPreview(PROJECT)).supported).toBe(false);
  });

  it("refuses Next.js, front-end though it is", async () => {
    // It has a server, server components and a router that runs on it.
    // "Previews except for the server-rendered half" is not a preview.
    await project("nextjs", { "src/main.js": "" });
    expect((await planBrowserPreview(PROJECT)).reason).toBe("needs-a-server");
  });

  it("refuses a project with compose services, whatever its template", async () => {
    await project("react-vite", {
      "src/main.tsx": "",
      "docker-compose.yml": "services: {}",
    });

    expect((await planBrowserPreview(PROJECT)).reason).toBe("needs-services");
  });

  it("refuses one with no entry file, and names where it looked", async () => {
    await project("react-vite", { "src/thing.tsx": "" });

    const plan = await planBrowserPreview(PROJECT);
    expect(plan.reason).toBe("no-entry");
    expect(plan.message).toContain("src/main.tsx");
  });

  it("does not walk node_modules", async () => {
    await project("react-vite", {
      "src/main.tsx": "",
      "node_modules/react/index.js": "// huge",
    });

    const plan = await planBrowserPreview(PROJECT);
    expect(Object.keys(plan.files ?? {})).not.toContain("node_modules/react/index.js");
  });

  it("refuses a tree with more source than it will ship", async () => {
    const files: Record<string, string> = { "src/main.tsx": "" };
    for (let index = 0; index < 250; index += 1) {
      files[`src/f${String(index)}.ts`] = "export const x = 1;";
    }
    await project("react-vite", files);

    expect((await planBrowserPreview(PROJECT)).reason).toBe("too-large");
  });

  it("collects the bare imports for the worker to fetch", async () => {
    await project("react-vite", {
      "src/main.tsx": "import React from 'react';\nimport './App';",
    });

    const plan = await planBrowserPreview(PROJECT);
    expect(plan.dependencies).toContain("react");
    // A relative import is not a dependency.
    expect(plan.dependencies).not.toContain("./App");
  });
});

describe("finding bare imports", () => {
  it("reads the three ways a project writes one", () => {
    const source = [
      "import React from 'react';",
      "import 'normalize.css';",
      "const x = require('lodash');",
    ].join("\n");

    expect(bareImports(source)).toEqual(["lodash", "normalize.css", "react"]);
  });

  it("keeps a scoped package and a deep import whole", () => {
    expect(bareImports("import x from '@scope/pkg/sub';")).toEqual([
      "@scope/pkg/sub",
    ]);
  });

  it("ignores relative paths and URLs", () => {
    const source = "import a from './a';\nimport b from 'https://x/b.js';";
    expect(bareImports(source)).toEqual([]);
  });
});

describe("whether a template is previewable", () => {
  it("is false for one that no longer exists", () => {
    // Otherwise a removed template id would be quietly treated as supported.
    expect(isPreviewableTemplate("gone")).toBe(false);
  });

  it("is true for a front-end one", () => {
    expect(isPreviewableTemplate("react-vite")).toBe(true);
  });
});
