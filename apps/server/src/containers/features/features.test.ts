import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  env: {
    DEVCONTAINER_FEATURES: true,
    DEVCONTAINER_FEATURE_REGISTRIES: ["ghcr.io"],
    DEVCONTAINER_FEATURE_LIMIT: 10,
    CONTAINER_MEMORY_MB: 2048,
  },
}));
vi.mock("../../config/env.js", () => envMock);
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/metrics.js", () => ({ increment: vi.fn() }));

import { featureRegistryAllowed, parseFeatureRef } from "./featureRef.js";
import { featureEnv, requestedOptions } from "./featureOptions.js";
import { orderFeatures } from "./featureOrder.js";
import { derivedImageTag, installScript } from "./featureBuild.js";

beforeEach(() => {
  envMock.env.DEVCONTAINER_FEATURE_REGISTRIES = ["ghcr.io"];
});

describe("naming a feature", () => {
  it("reads the ordinary form", () => {
    const ref = parseFeatureRef("ghcr.io/devcontainers/features/node:1");
    expect(ref).toMatchObject({
      registry: "ghcr.io",
      repository: "devcontainers/features/node",
      tag: "1",
      digest: null,
    });
  });

  it("reads one pinned by digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseFeatureRef(`ghcr.io/x/y@${digest}`).digest).toBe(digest);
  });

  it("defaults the tag rather than leaving it unset", () => {
    expect(parseFeatureRef("ghcr.io/x/y").tag).toBe("latest");
  });

  it("does not mistake a registry port for a tag", () => {
    // Searched from the end and after the digest split, or `localhost:5000/x`
    // parses as the repository `localhost` at tag `5000/x`.
    const ref = parseFeatureRef("localhost:5000/x/y:2");
    expect(ref.registry).toBe("localhost:5000");
    expect(ref.tag).toBe("2");
  });

  it("refuses a path inside the repository, by name", () => {
    // "Invalid" would send somebody to check their spelling of a form that is
    // never going to work here.
    expect(() => parseFeatureRef("./my-feature")).toThrow(/path in the repository/);
  });

  it("refuses a URL, by name", () => {
    expect(() => parseFeatureRef("https://example.com/f.tgz")).toThrow(/from a URL/);
  });

  it("refuses one that names no registry", () => {
    // Not defaulted to Docker Hub: the allowlist is written in terms of hosts,
    // and supplying one quietly would mean it governs a host nobody wrote down.
    expect(() => parseFeatureRef("node:1")).toThrow(/must name its registry/);
  });

  it("refuses a digest that is not one", () => {
    expect(() => parseFeatureRef("ghcr.io/x/y@sha256:nope")).toThrow(/not a sha256/);
  });

  it("refuses something absurdly long", () => {
    expect(() => parseFeatureRef(`ghcr.io/${"a".repeat(300)}`)).toThrow(/too long/);
  });
});

describe("whose features may run", () => {
  const ref = parseFeatureRef("ghcr.io/devcontainers/features/node:1");

  it("permits an allowlisted host", () => {
    expect(featureRegistryAllowed(ref, ["ghcr.io"])).toBe(true);
  });

  it("refuses one that is not", () => {
    // This list decides whose code runs as root.
    expect(featureRegistryAllowed(ref, ["mcr.microsoft.com"])).toBe(false);
  });

  it("has a wildcard, and it is exactly as alarming as it looks", () => {
    expect(featureRegistryAllowed(ref, ["*"])).toBe(true);
  });

  it("does not match a host by prefix", () => {
    // `ghcr.io.evil.example` must not pass because it starts with ghcr.io.
    const hostile = parseFeatureRef("ghcr.io.evil.example/x/y:1");
    expect(featureRegistryAllowed(hostile, ["ghcr.io"])).toBe(false);
  });
});

describe("the options an install script sees", () => {
  const metadata = {
    options: {
      version: { type: "string" as const, default: "lts" },
      installTools: { type: "boolean" as const, default: true },
      flavour: { type: "string" as const, enum: ["a", "b"], default: "a" },
    },
  };

  it("uppercases the names, as the spec says", () => {
    expect(featureEnv(metadata, {})).toEqual({
      VERSION: "lts",
      INSTALLTOOLS: "true",
      FLAVOUR: "a",
    });
  });

  it("takes the declared default when nothing was asked for", () => {
    expect(featureEnv(metadata, { version: "20" }).VERSION).toBe("20");
    expect(featureEnv(metadata, { version: "20" }).INSTALLTOOLS).toBe("true");
  });

  it("renders a boolean as true/false rather than 1/0", () => {
    expect(featureEnv(metadata, { installTools: false }).INSTALLTOOLS).toBe("false");
  });

  it("refuses a value outside an enum", () => {
    expect(() => featureEnv(metadata, { flavour: "c" })).toThrow(/is not one of/);
  });

  it("refuses a newline, which would be a second environment entry", () => {
    // These values are interpolated into the environment of a script running
    // as root, and they come from a file this platform did not write.
    expect(() => featureEnv(metadata, { version: "20\nPATH=/evil" })).toThrow(
      /cannot contain a newline/,
    );
  });

  it("names an option the feature does not have", () => {
    // A typo otherwise produces a feature that installs with its defaults,
    // which looks like it worked.
    expect(() => featureEnv(metadata, { verison: "20" })).toThrow(/is not an option/);
  });

  it("drops nothing silently: an undeclared option is an error, not ignored", () => {
    expect(() => featureEnv({ options: {} }, { anything: "1" })).toThrow();
  });

  it("reads the string shorthand as a version", () => {
    expect(requestedOptions("20", "x")).toEqual({ version: "20" });
  });

  it("reads an empty object and a null as nothing asked for", () => {
    expect(requestedOptions({}, "x")).toEqual({});
    expect(requestedOptions(null, "x")).toEqual({});
  });

  it("refuses options that are neither", () => {
    expect(() => requestedOptions([1], "x")).toThrow(/must be an object/);
  });
});

describe("what order they install in", () => {
  it("keeps the file's order when nothing says otherwise", () => {
    // A file's own order is the only intent anybody expressed.
    const ordered = orderFeatures([{ id: "a/one:1" }, { id: "a/two:1" }]);
    expect(ordered.map((f) => f.id)).toEqual(["a/one:1", "a/two:1"]);
  });

  it("honours installsAfter", () => {
    const ordered = orderFeatures([
      { id: "ghcr.io/x/node:1", installsAfter: ["ghcr.io/x/common"] },
      { id: "ghcr.io/x/common:2" },
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["ghcr.io/x/common:2", "ghcr.io/x/node:1"]);
  });

  it("matches installsAfter without the version", () => {
    // installsAfter names a feature without one; the file's id usually carries
    // one. Comparing whole strings would satisfy no dependency at all.
    const ordered = orderFeatures([
      { id: "ghcr.io/x/node:1.2.3", installsAfter: ["ghcr.io/x/common"] },
      { id: "ghcr.io/x/common:2" },
    ]);
    expect(ordered[0]?.id).toBe("ghcr.io/x/common:2");
  });

  it("ignores a dependency that was not asked for", () => {
    // The spec treats installsAfter as ordering among what IS installed.
    const ordered = orderFeatures([
      { id: "ghcr.io/x/node:1", installsAfter: ["ghcr.io/x/absent"] },
    ]);
    expect(ordered).toHaveLength(1);
  });

  it("refuses a cycle rather than breaking it", () => {
    // Picking one arbitrarily would build here and not in a real devcontainer,
    // which is worse than not building.
    expect(() =>
      orderFeatures([
        { id: "a/one:1", installsAfter: ["a/two"] },
        { id: "a/two:1", installsAfter: ["a/one"] },
      ]),
    ).toThrow(/each be installed after the other/);
  });
});

describe("the image a set of features produces", () => {
  const base = "node:22-bookworm-slim";

  it("is the same for the same features and options", () => {
    const one = derivedImageTag(base, [{ digest: "sha256:a", env: { V: "1" } }]);
    const two = derivedImageTag(base, [{ digest: "sha256:a", env: { V: "1" } }]);
    // Two projects asking for the same thing must share one image, or every
    // project pays the install again.
    expect(one).toBe(two);
  });

  it("changes when the digest changes", () => {
    // Keyed on the resolved digest, not the tag it was written as: a `:1` that
    // has moved must not be served yesterday's software.
    expect(derivedImageTag(base, [{ digest: "sha256:a", env: {} }])).not.toBe(
      derivedImageTag(base, [{ digest: "sha256:b", env: {} }]),
    );
  });

  it("changes when an option changes", () => {
    expect(derivedImageTag(base, [{ digest: "sha256:a", env: { V: "1" } }])).not.toBe(
      derivedImageTag(base, [{ digest: "sha256:a", env: { V: "2" } }]),
    );
  });

  it("changes when the base image changes", () => {
    expect(derivedImageTag(base, [{ digest: "sha256:a", env: {} }])).not.toBe(
      derivedImageTag("python:3.12", [{ digest: "sha256:a", env: {} }]),
    );
  });
});

describe("the script that runs them", () => {
  const feature = {
    id: "ghcr.io/x/node:1",
    digest: "sha256:a",
    directory: "/tmp/x",
    env: { VERSION: "20" },
    containerEnv: {},
  };

  it("stops at the first failure", () => {
    expect(installScript([feature])).toMatch(/^set -e/);
  });

  it("enters each feature's own folder first", () => {
    // The spec lets an install script assume its own folder is the working
    // directory, and most of them do without saying so.
    expect(installScript([feature])).toContain("cd /tmp/rc-features/0");
  });

  it("single-quotes an option value, so a space is one value", () => {
    const spaced = { ...feature, env: { VERSION: "a b" } };
    expect(installScript([spaced])).toContain("export VERSION='a b'");
  });

  it("escapes a quote inside a value", () => {
    const quoted = { ...feature, env: { VERSION: "it's" } };
    expect(installScript([quoted])).toContain(`export VERSION='it'\\''s'`);
  });

  it("runs them in the order it was given", () => {
    const second = { ...feature, id: "ghcr.io/x/go:1", directory: "/tmp/y" };
    const script = installScript([feature, second]);
    expect(script.indexOf("/tmp/rc-features/0")).toBeLessThan(
      script.indexOf("/tmp/rc-features/1"),
    );
  });
});
