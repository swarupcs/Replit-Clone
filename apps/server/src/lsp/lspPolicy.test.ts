import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({
  env: { LSP_ENABLED: true, CONTAINER_MEMORY_MB: 2048, LSP_MIN_CONTAINER_MEMORY_MB: 1024 },
}));
vi.mock("../config/env.js", () => ({ env }));

const { canStartLanguageServer, LANGUAGE_SERVERS, servesImage } = await import(
  "./lspPolicy.js"
);

describe("canStartLanguageServer", () => {
  beforeEach(() => {
    env.LSP_ENABLED = true;
    env.CONTAINER_MEMORY_MB = 2048;
    env.LSP_MIN_CONTAINER_MEMORY_MB = 1024;
  });

  it("allows Python when there is room", () => {
    expect(canStartLanguageServer("python")).toEqual({ allowed: true });
  });

  it("refuses when the deployment has not enabled them", () => {
    env.LSP_ENABLED = false;
    const verdict = canStartLanguageServer("python");
    expect(verdict).toMatchObject({ allowed: false, code: "DISABLED" });
  });

  it("refuses a language it has no server for", () => {
    // Ruby rather than Rust since §10.8, which added a Rust entry and an image
    // to go with it. The example moved; the rule did not.
    expect(canStartLanguageServer("ruby")).toMatchObject({
      allowed: false,
      code: "UNSUPPORTED_LANGUAGE",
    });
  });

  /** The point of the whole policy, and the one number in it worth knowing:
   *  a language server idles in the low hundreds of MB while
   *  CONTAINER_MEMORY_MB defaults to 512, so an unconditional start would have
   *  the server competing with the dev server it exists to help. See
   *  `docs/ROADMAP.md` §6, decision 3 -- which was originally argued from
   *  pyright, and pyright is not what shipped. */
  it("refuses rather than risking the dev server for memory", () => {
    env.CONTAINER_MEMORY_MB = 512;
    expect(canStartLanguageServer("python")).toMatchObject({
      allowed: false,
      code: "NOT_ENOUGH_MEMORY",
    });
  });

  it("says the numbers, so an operator can act on the refusal", () => {
    env.CONTAINER_MEMORY_MB = 512;
    const verdict = canStartLanguageServer("python");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.message).toContain("1024");
      expect(verdict.message).toContain("512");
    }
  });

  it("allows exactly at the threshold", () => {
    env.CONTAINER_MEMORY_MB = 1024;
    expect(canStartLanguageServer("python")).toEqual({ allowed: true });
  });

  /** The order matters: a deployment with LSP off should say so rather than
   *  complaining about memory it was never going to use. */
  it("reports being disabled before anything else", () => {
    env.LSP_ENABLED = false;
    env.CONTAINER_MEMORY_MB = 128;
    expect(canStartLanguageServer("python")).toMatchObject({ code: "DISABLED" });
  });
});

describe("the second language", () => {
  beforeEach(() => {
    env.LSP_ENABLED = true;
    env.CONTAINER_MEMORY_MB = 2048;
    env.LSP_MIN_CONTAINER_MEMORY_MB = 1024;
  });

  /** Adding Go was meant to be a registry entry and an image that carries the
   *  binary. It was — but only after the mechanism underneath was made to work
   *  at all: the gateway execed with `WorkingDir: "/app"`, which exists in
   *  none of the sandbox images, so Docker refused to start the process and no
   *  language server had ever run. Both servers are now verified against real
   *  containers; these tests hold the registry honest. */
  it("knows how to start gopls", () => {
    expect(canStartLanguageServer("go")).toEqual({ allowed: true });
  });

  it("applies the same memory refusal to every language", () => {
    // The refusal is a property of the platform, not of Python.
    env.CONTAINER_MEMORY_MB = 512;
    expect(canStartLanguageServer("go")).toMatchObject({
      allowed: false,
      code: "NOT_ENOUGH_MEMORY",
    });
  });
});

describe("a file whose language the container cannot serve", () => {
  beforeEach(() => {
    env.LSP_ENABLED = true;
    env.CONTAINER_MEMORY_MB = 2048;
    env.LSP_MIN_CONTAINER_MEMORY_MB = 1024;
  });

  /** A `.py` file can be opened in a Node project, and nothing stopped the
   *  gateway from asking that container for `pylsp`. The failure arrived as
   *  "executable file not found" from `exec`, halfway through a WebSocket
   *  handshake, at a client that had already been told the server was
   *  starting. */
  it("is refused with a reason rather than by exec failing", () => {
    const verdict = canStartLanguageServer("python", "sandbox-node:latest");

    expect(verdict).toMatchObject({ allowed: false, code: "WRONG_IMAGE" });
  });

  it("names both the image it needs and the one it got", () => {
    const verdict = canStartLanguageServer("go", "sandbox-python:latest");

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.message).toContain("sandbox-go:latest");
      expect(verdict.message).toContain("sandbox-python:latest");
    }
  });

  it("allows the language its own image carries", () => {
    expect(canStartLanguageServer("go", "sandbox-go:latest")).toEqual({
      allowed: true,
    });
    expect(canStartLanguageServer("python", "sandbox-python:latest")).toEqual({
      allowed: true,
    });
  });

  it("still answers when the caller has not resolved an image", () => {
    // Optional on purpose: a caller that knows the language but not yet the
    // template can still ask the cheap questions.
    expect(canStartLanguageServer("python")).toEqual({ allowed: true });
  });

  it("reports an unsupported language before an image mismatch", () => {
    // "No server for Ruby" is the useful sentence; "Ruby needs the Ruby image"
    // would be a lie about an image that does not exist. That warning is why
    // §10.8 added `images/rust` and `images/cpp` rather than only registry
    // entries pointing at images nothing builds.
    expect(canStartLanguageServer("ruby", "sandbox-node:latest")).toMatchObject({
      code: "UNSUPPORTED_LANGUAGE",
    });
  });
});

/** plan.md §10.8. The registry grew from two languages to seven, and the two
 *  things that changed shape are worth holding: a server can belong to more
 *  than one image, and every image named here is one this repository builds. */
describe("languages past Python and Go", () => {
  it("serves TypeScript and JavaScript from the node image", () => {
    // The most valuable entry: Monaco's own worker is per model, so it sees the
    // file and not the project.
    for (const language of ["typescript", "javascript"]) {
      expect(
        canStartLanguageServer(language, "sandbox-node:latest"),
      ).toEqual({ allowed: true });
    }
  });

  it("drives both through one tsserver", () => {
    expect(LANGUAGE_SERVERS["javascript"]?.argv).toEqual(
      LANGUAGE_SERVERS["typescript"]?.argv,
    );
  });

  it("serves C and C++ from one image", () => {
    expect(LANGUAGE_SERVERS["c"]?.images).toEqual(LANGUAGE_SERVERS["cpp"]?.images);
  });

  it("names an image this repository actually builds", () => {
    // The test above warns that naming an image that does not exist is a lie in
    // the refusal message. This is that warning as a check: every image in the
    // registry is one `pnpm images:build` produces.
    const built = new Set([
      "sandbox-node:latest",
      "sandbox-python:latest",
      "sandbox-go:latest",
      "sandbox-rust:latest",
      "sandbox-cpp:latest",
    ]);

    for (const server of Object.values(LANGUAGE_SERVERS)) {
      for (const image of server.images) expect(built.has(image)).toBe(true);
    }
  });

  it("accepts any of a server's images, not just the first", () => {
    // No entry names two images today, so this is checked against the function
    // rather than through the registry -- otherwise the list behaviour would be
    // latent, and a check comparing only the first image would pass identically
    // until the day somebody added a second.
    const twoImages = { argv: ["x"], images: ["a:latest", "b:latest"] };

    expect(servesImage(twoImages, "a:latest")).toBe(true);
    expect(servesImage(twoImages, "b:latest")).toBe(true);
    expect(servesImage(twoImages, "c:latest")).toBe(false);
  });

  it("still refuses a TypeScript file riding in a Python project", () => {
    const refusal = canStartLanguageServer("typescript", "sandbox-python:latest");
    expect(refusal).toMatchObject({ allowed: false, code: "WRONG_IMAGE" });
  });
});
