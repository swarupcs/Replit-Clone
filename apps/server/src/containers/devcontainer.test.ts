import { describe, expect, it } from "vitest";
import {
  DevcontainerError,
  interpret,
  resolveWorkspaceFolder,
  stripJsonc,
} from "./devcontainer.js";

const SOURCE = ".devcontainer/devcontainer.json";

function read(raw: unknown) {
  return interpret(raw, SOURCE);
}

describe("stripJsonc", () => {
  it("removes line and block comments", () => {
    expect(
      stripJsonc(`{
        // the image
        "image": "node:20", /* inline */
        "forwardPorts": [3000]
      }`),
    ).toContain('"image": "node:20"');
  });

  it("leaves a // that is inside a string alone", () => {
    // The reason this walks the text instead of running a regex over it: an
    // image name contains a URL, and a regex would truncate it.
    const stripped = stripJsonc(
      '{"image": "mcr.microsoft.com/devcontainers/javascript-node:20"}',
    );

    expect(JSON.parse(stripped)).toEqual({
      image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    });
  });

  it("survives an escaped quote inside a string", () => {
    const stripped = stripJsonc('{"postCreateCommand": "echo \\"hi\\" // not a comment"}');

    expect(JSON.parse(stripped)).toEqual({
      postCreateCommand: 'echo "hi" // not a comment',
    });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(
      JSON.parse(stripJsonc('{"forwardPorts": [3000, 5173,], "image": "node:20",}')),
    ).toEqual({ forwardPorts: [3000, 5173], image: "node:20" });
  });

  it("does not eat a comma inside a string", () => {
    expect(JSON.parse(stripJsonc('{"a": "x, y"}'))).toEqual({ a: "x, y" });
  });
});

describe("interpret", () => {
  it("reads the keys it acts on", () => {
    const config = read({
      name: "My project",
      image: "sandbox-node:latest",
      containerEnv: { API_URL: "http://localhost:3000" },
      forwardPorts: [3000, 5173],
      postCreateCommand: "npm ci",
      workspaceFolder: "/home/sandbox/app",
    });

    expect(config.image).toBe("sandbox-node:latest");
    expect(config.containerEnv).toEqual({ API_URL: "http://localhost:3000" });
    expect(config.forwardPorts).toEqual([3000, 5173]);
    expect(config.postCreateCommand).toEqual(["npm ci"]);
  });

  it("says which keys it did not act on, and why", () => {
    // A half-applied config is worse than a rejected one, because the user
    // cannot tell which half ran.
    const config = read({
      image: "node:20",
      features: { "ghcr.io/devcontainers/features/go:1": {} },
      mounts: ["source=x,target=y"],
    });

    const keys = config.unsupported.map((entry) => entry.key);
    expect(keys).toContain("features");
    expect(keys).toContain("mounts");
    expect(config.unsupported.find((e) => e.key === "features")?.reason).toMatch(
      /postCreateCommand/,
    );
  });

  it("names the Dockerfile case specifically, since it is the common one", () => {
    const config = read({ build: { dockerfile: "Dockerfile" } });

    expect(config.unsupported[0]?.reason).toMatch(/image/i);
  });

  it("does not complain about keys it understands and deliberately ignores", () => {
    // remoteUser cannot be honoured -- the uid has to match the bind mount's
    // owner or the container cannot write the project. Reporting it as
    // "unsupported" would be noise on almost every real config.
    const config = read({
      name: "x",
      remoteUser: "node",
      customizations: { vscode: { extensions: ["dbaeumer.vscode-eslint"] } },
      settings: {},
      $schema: "https://example.com/schema.json",
    });

    expect(config.unsupported).toEqual([]);
  });

  it("normalises the three shapes a lifecycle command can take", () => {
    expect(read({ postCreateCommand: "npm ci" }).postCreateCommand).toEqual([
      "npm ci",
    ]);

    // An argv array is ONE command, quoted back together.
    expect(
      read({ postCreateCommand: ["npm", "ci", "--no-audit"] }).postCreateCommand,
    ).toEqual(["npm ci --no-audit"]);

    // An object is several, run in order.
    expect(
      read({ postCreateCommand: { deps: "npm ci", build: "npm run build" } })
        .postCreateCommand,
    ).toEqual(["npm ci", "npm run build"]);
  });

  it("quotes an argv entry that the shell would otherwise split", () => {
    expect(
      read({ postCreateCommand: ["echo", "hello world; rm -rf /"] })
        .postCreateCommand,
    ).toEqual(["echo 'hello world; rm -rf /'"]);
  });

  it("merges remoteEnv and containerEnv, container-level last", () => {
    const config = read({
      remoteEnv: { A: "1", B: "from-remote" },
      containerEnv: { B: "from-container" },
    });

    expect(config.containerEnv).toEqual({ A: "1", B: "from-container" });
  });

  it("refuses a config that is not an object", () => {
    expect(() => read([])).toThrow(DevcontainerError);
    expect(() => read("nope")).toThrow(DevcontainerError);
    expect(() => read(null)).toThrow(DevcontainerError);
  });

  it("refuses an image that is not a string", () => {
    expect(() => read({ image: 42 })).toThrow(DevcontainerError);
    expect(() => read({ image: "  " })).toThrow(DevcontainerError);
  });

  it("refuses a non-string environment value rather than coercing it", () => {
    // Coercing 3000 to "3000" would be convenient and would hide a mistake in
    // a file the user can fix.
    expect(() => read({ containerEnv: { PORT: 3000 } })).toThrow(/quoting/);
  });

  it("refuses a forwardPorts entry that is not a port", () => {
    expect(() => read({ forwardPorts: ["db:5432"] })).toThrow(DevcontainerError);
    expect(() => read({ forwardPorts: [0] })).toThrow(DevcontainerError);
    expect(() => read({ forwardPorts: [70000] })).toThrow(DevcontainerError);
  });

  it("accepts a port written as a string, which real configs do", () => {
    expect(read({ forwardPorts: ["3000"] }).forwardPorts).toEqual([3000]);
  });

  it("drops duplicate ports", () => {
    expect(read({ forwardPorts: [3000, 3000, 5173] }).forwardPorts).toEqual([
      3000, 5173,
    ]);
  });

  it("leaves absent keys absent rather than defaulting them", () => {
    // The template supplies the defaults; an absent key must not overwrite one.
    const config = read({ name: "x" });

    expect(config.image).toBeUndefined();
    expect(config.forwardPorts).toBeUndefined();
    expect(config.postCreateCommand).toBeUndefined();
  });
});

describe("resolveWorkspaceFolder", () => {
  const MOUNT = "/home/sandbox/app";

  it("defaults to the mount point", () => {
    expect(resolveWorkspaceFolder(undefined, MOUNT)).toBe(MOUNT);
  });

  it("allows a subdirectory, which is the monorepo case", () => {
    expect(resolveWorkspaceFolder("/home/sandbox/app/packages/web", MOUNT)).toBe(
      "/home/sandbox/app/packages/web",
    );
    expect(resolveWorkspaceFolder("packages/web", MOUNT)).toBe(
      "/home/sandbox/app/packages/web",
    );
  });

  it("refuses to leave the mount, falling back rather than failing", () => {
    // A workspaceFolder outside the mount would put the shell somewhere the
    // user's files are not. Falling back is better than refusing to start.
    expect(resolveWorkspaceFolder("/etc", MOUNT)).toBe(MOUNT);
    expect(resolveWorkspaceFolder("/home/sandbox/app/../../etc", MOUNT)).toBe(MOUNT);
    expect(resolveWorkspaceFolder("../../etc", MOUNT)).toBe(MOUNT);
  });

  it("does not let a sibling whose name merely starts the same through", () => {
    expect(resolveWorkspaceFolder("/home/sandbox/app-other", MOUNT)).toBe(MOUNT);
  });
});
