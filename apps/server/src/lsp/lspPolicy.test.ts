import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({
  env: { LSP_ENABLED: true, CONTAINER_MEMORY_MB: 2048, LSP_MIN_CONTAINER_MEMORY_MB: 1024 },
}));
vi.mock("../config/env.js", () => ({ env }));

const { canStartLanguageServer } = await import("./lspPolicy.js");

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
    expect(canStartLanguageServer("rust")).toMatchObject({
      allowed: false,
      code: "UNSUPPORTED_LANGUAGE",
    });
  });

  /** §3.3's central point: pyright idles at 150-300 MB and
   *  CONTAINER_MEMORY_MB defaults to 512, so an unconditional start would
   *  have the server competing with the dev server it exists to help. */
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
    // "No server for Rust" is the useful sentence; "Rust needs the Rust image"
    // would be a lie about an image that does not exist.
    expect(canStartLanguageServer("rust", "sandbox-node:latest")).toMatchObject({
      code: "UNSUPPORTED_LANGUAGE",
    });
  });
});
