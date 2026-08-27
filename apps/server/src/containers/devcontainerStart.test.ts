import { describe, expect, it } from "vitest";
import { envSignature } from "./containerManager.js";
import type { DevcontainerConfig } from "./devcontainer.js";
import { imageAllowed, isValidImageReference } from "./devcontainer.js";

/** That the config actually reaches the container.
 *
 *  `devcontainer.test.ts` covers reading the file, which is pure. This covers
 *  the two decisions taken with what it read: whether an image may be used at
 *  all, and whether a change to the file rebuilds the container — which is the
 *  one that would silently do nothing if it were wrong.
 */

const base: DevcontainerConfig = { source: "x", unsupported: [] };

describe("imageAllowed", () => {
  const allowlist = [
    "sandbox-node:latest",
    "sandbox-python:latest",
    "mcr.microsoft.com/devcontainers/*",
  ];

  it("permits an exact entry", () => {
    expect(imageAllowed("sandbox-node:latest", allowlist)).toBe(true);
  });

  it("permits anything under a trailing wildcard", () => {
    expect(
      imageAllowed("mcr.microsoft.com/devcontainers/javascript-node:20", allowlist),
    ).toBe(true);
  });

  it("refuses an image that is merely similar", () => {
    // The tag is part of the identity: sandbox-node:evil is not
    // sandbox-node:latest, and a prefix match here would be a way in.
    expect(imageAllowed("sandbox-node:evil", allowlist)).toBe(false);
    expect(imageAllowed("evil/sandbox-node:latest", allowlist)).toBe(false);
  });

  it("refuses a registry nobody allowed", () => {
    expect(imageAllowed("docker.io/library/postgres:17", allowlist)).toBe(false);
  });

  it("does not treat a wildcard as matching its own prefix boundary loosely", () => {
    // "mcr.microsoft.com/devcontainers-evil/..." starts with the allowlisted
    // text only if the trailing slash is dropped, which it must not be.
    expect(
      imageAllowed("mcr.microsoft.com/devcontainers-evil/x:1", allowlist),
    ).toBe(false);
  });

  it("honours a bare * for a deployment that means it", () => {
    expect(imageAllowed("anything/at:all", ["*"])).toBe(true);
  });

  it("refuses everything against an empty allowlist", () => {
    expect(imageAllowed("sandbox-node:latest", [])).toBe(false);
  });
});

describe("isValidImageReference", () => {
  it("accepts the shapes real images take", () => {
    for (const image of [
      "node",
      "node:20",
      "sandbox-node:latest",
      "mcr.microsoft.com/devcontainers/javascript-node:20",
      "localhost:5000/team/app:1.2.3",
      `node@sha256:${"a".repeat(64)}`,
    ]) {
      expect(isValidImageReference(image)).toBe(true);
    }
  });

  it("refuses anything that is not one", () => {
    for (const image of [
      "",
      "Node:20",
      "node:20;rm -rf /",
      "node 20",
      "-node:20",
      "a".repeat(300),
    ]) {
      expect(isValidImageReference(image)).toBe(false);
    }
  });
});

describe("envSignature with a devcontainer", () => {
  it("changes when the image changes", () => {
    // Otherwise editing devcontainer.json would change nothing until something
    // else happened to force a rebuild — the same defect the environment
    // variables once had.
    const before = envSignature({}, { ...base, image: "sandbox-node:latest" });
    const after = envSignature({}, { ...base, image: "sandbox-python:latest" });

    expect(before).not.toBe(after);
  });

  it("changes when a lifecycle command changes", () => {
    expect(envSignature({}, { ...base, postCreateCommand: ["npm ci"] })).not.toBe(
      envSignature({}, { ...base, postCreateCommand: ["npm install"] }),
    );
  });

  it("changes when a forwarded port is added", () => {
    expect(envSignature({}, { ...base, forwardPorts: [3000] })).not.toBe(
      envSignature({}, { ...base, forwardPorts: [3000, 8080] }),
    );
  });

  it("changes when the workspace folder changes", () => {
    expect(envSignature({}, { ...base, workspaceFolder: "/a" })).not.toBe(
      envSignature({}, { ...base, workspaceFolder: "/b" }),
    );
  });

  it("changes between having a config and not having one", () => {
    expect(envSignature({}, null)).not.toBe(
      envSignature({}, { ...base, image: "sandbox-node:latest" }),
    );
  });

  it("does NOT change when only the refusal wording does", () => {
    // `unsupported` describes how this READ the file, not what the container
    // is. Rewording a message must not cost every user a rebuild.
    const a = envSignature({}, { ...base, image: "sandbox-node:latest" });
    const b = envSignature({}, {
      ...base,
      image: "sandbox-node:latest",
      source: ".devcontainer.json",
      unsupported: [{ key: "features", reason: "reworded since" }],
    });

    expect(a).toBe(b);
  });

  it("still reflects the environment variables it always did", () => {
    expect(envSignature({ A: "1" }, base)).not.toBe(
      envSignature({ A: "2" }, base),
    );
  });

  it("is unchanged for a project with no devcontainer at all", () => {
    // Every existing project is this case, and none of them should rebuild
    // just because this feature landed.
    expect(envSignature({ A: "1" })).toBe(envSignature({ A: "1" }, null));
  });
});
