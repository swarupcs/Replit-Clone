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
