import { beforeEach, describe, expect, it, vi } from "vitest";

/** Whether a notebook kernel may start. plan.md §12.3.
 *
 *  **Every assertion here is about a sentence somebody reads**, not about a
 *  boolean. A notebook whose Run button does nothing is indistinguishable
 *  from a broken editor, and the only thing that tells those apart is the
 *  refusal — so the refusals are tested for their content, not only for
 *  their existence.
 */

const state = vi.hoisted(() => ({
  env: {
    NOTEBOOKS_ENABLED: true,
    CONTAINER_MEMORY_MB: 2048,
    KERNEL_MIN_CONTAINER_MEMORY_MB: 1536,
  },
}));

vi.mock("../config/env.js", () => ({ env: state.env }));

const { canStartKernel, kernelForLanguage, KERNELS } = await import(
  "./kernelPolicy.js"
);

const PYTHON_IMAGE = "sandbox-python:latest";

beforeEach(() => {
  state.env.NOTEBOOKS_ENABLED = true;
  state.env.CONTAINER_MEMORY_MB = 2048;
  state.env.KERNEL_MIN_CONTAINER_MEMORY_MB = 1536;
});

describe("the ordinary case", () => {
  it("allows a Python notebook in a Python project", () => {
    expect(canStartKernel("python", PYTHON_IMAGE)).toEqual({ allowed: true });
  });
});

describe("what a notebook's own metadata asks for", () => {
  /** Every Python notebook records `python` here, and a notebook with no
   *  kernelspec at all is overwhelmingly a Python one. */
  it.each([
    ["python", "python"],
    [undefined, "python"],
    ["Python", "python"],
  ])("%s resolves to %s", (declared, expected) => {
    expect(kernelForLanguage(declared)).toBe(expected);
  });

  /** **The one that matters.** "Use the only kernel we have" would hand an R
   *  notebook to Python and fail on line one with a SyntaxError — which reads
   *  as a broken kernel rather than as an unsupported language. */
  it.each(["r", "julia", "javascript"])(
    "resolves %s to nothing rather than to Python",
    (language) => {
      expect(kernelForLanguage(language)).toBeNull();
    },
  );
});

describe("the refusals", () => {
  it("says so when the deployment runs no kernels", () => {
    state.env.NOTEBOOKS_ENABLED = false;

    const verdict = canStartKernel("python", PYTHON_IMAGE);
    expect(verdict).toMatchObject({ allowed: false, code: "DISABLED" });
  });

  /** The distinction the message has to carry: the file is fine, the editor
   *  is fine, and only Run is unavailable. Without that sentence a user
   *  reasonably concludes the notebook did not open. */
  it("tells an R notebook that it still opens and edits", () => {
    const verdict = canStartKernel("r", PYTHON_IMAGE);

    expect(verdict).toMatchObject({ code: "UNSUPPORTED_LANGUAGE" });
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.message).toMatch(/opens and edits/);
    expect(verdict.message).toMatch(/only Run/);
  });

  /** A `.ipynb` is perfectly openable in a Node project, and asking that
   *  container for `rc-kernel` gets "executable file not found" halfway
   *  through a WebSocket handshake — a failure with no reason attached. */
  it("refuses a notebook in a container that has no kernel in it", () => {
    const verdict = canStartKernel("python", "sandbox-node:latest");

    expect(verdict).toMatchObject({ code: "WRONG_IMAGE" });
    if (verdict.allowed) throw new Error("expected a refusal");
    // Both ways round: what is needed, and what this project actually runs.
    expect(verdict.message).toContain("sandbox-python:latest");
    expect(verdict.message).toContain("sandbox-node:latest");
  });

  it("refuses when the container is too small, and names the numbers", () => {
    state.env.CONTAINER_MEMORY_MB = 512;

    const verdict = canStartKernel("python", PYTHON_IMAGE);

    expect(verdict).toMatchObject({ code: "NOT_ENOUGH_MEMORY" });
    if (verdict.allowed) throw new Error("expected a refusal");
    // An operator can only act on this if the numbers are in it.
    expect(verdict.message).toContain("1536");
    expect(verdict.message).toContain("512");
  });

  /** The kernel threshold is higher than the language server's on purpose: a
   *  server indexes a project and idles, a kernel holds whatever the user
   *  assigned to a variable. A deployment sized for one is not thereby sized
   *  for the other. */
  it("refuses at a size that would have allowed a language server", () => {
    state.env.CONTAINER_MEMORY_MB = 1024;

    expect(canStartKernel("python", PYTHON_IMAGE)).toMatchObject({
      allowed: false,
      code: "NOT_ENOUGH_MEMORY",
    });
  });

  /** Order matters: a disabled deployment must say it is disabled, not that
   *  the container is too small. The second is actionable and wrong, which is
   *  worse than unhelpful — somebody would go and raise the memory limit. */
  it("reports being switched off ahead of every other reason", () => {
    state.env.NOTEBOOKS_ENABLED = false;
    state.env.CONTAINER_MEMORY_MB = 128;

    expect(canStartKernel("r", "sandbox-node:latest")).toMatchObject({
      code: "DISABLED",
    });
  });
});

describe("the registry", () => {
  /** §12.3 says this row is "worth doing only if you write Python". One entry
   *  is what that sentence looks like in code — pinned so a second one is a
   *  deliberate act with a kernel behind it, not a hopeful line. */
  it("claims exactly the one kernel that is installed in an image", () => {
    expect(Object.keys(KERNELS)).toEqual(["python"]);
    expect(KERNELS["python"]).toMatchObject({
      argv: ["rc-kernel"],
      image: PYTHON_IMAGE,
    });
  });
});
