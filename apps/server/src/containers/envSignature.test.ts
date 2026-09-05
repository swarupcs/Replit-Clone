import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { envSignature } from "./containerManager.js";

/** What the signature has to guarantee.
 *
 *  A container's environment is fixed when Docker creates it, so the only way
 *  new variables reach a project is to notice the set has changed and build the
 *  container again. This label is that comparison. Getting it wrong in one
 *  direction rebuilds a container on every start; in the other it goes back to
 *  the original defect, where saved variables silently never applied.
 */
describe("envSignature", () => {
  it("is the same for the same variables", () => {
    expect(envSignature({ API_URL: "https://x", TOKEN: "abc" })).toBe(
      envSignature({ API_URL: "https://x", TOKEN: "abc" }),
    );
  });

  it("ignores the order they were written in", () => {
    // Object key order follows insertion, and editing one variable in the UI
    // can reorder the whole record. Rebuilding the container for that would be
    // a restart the user did not ask for.
    expect(envSignature({ A: "1", B: "2" })).toBe(envSignature({ B: "2", A: "1" }));
  });

  it("changes when a value changes", () => {
    expect(envSignature({ TOKEN: "abc" })).not.toBe(envSignature({ TOKEN: "xyz" }));
  });

  it("changes when a variable is added or removed", () => {
    const one = envSignature({ A: "1" });

    expect(one).not.toBe(envSignature({ A: "1", B: "2" }));
    expect(one).not.toBe(envSignature({}));
  });

  /** The signature read only the project's inputs, so a change to how a
   *  container is BUILT reached a project on its next cold start and not
   *  before — and a container that lives for days would have gone on running
   *  the old shape indefinitely. That is the same defect the signature exists
   *  to close, arriving from the other side.
   *
   *  Asserted by rebuilding the hash the old way rather than against a fixed
   *  digest: a golden value here would say what the signature IS, and what
   *  matters is that the shape is one of its inputs. */
  it("takes the container's own shape into account, not just the project's", () => {
    const vars = { A: "1" };
    const projectInputsAlone = createHash("sha256")
      .update(JSON.stringify([["A", "1"]]))
      .digest("hex")
      .slice(0, 32);

    expect(envSignature(vars)).not.toBe(projectInputsAlone);
  });

  it("tells apart a rename that keeps the value", () => {
    expect(envSignature({ A: "1" })).not.toBe(envSignature({ B: "1" }));
  });

  it("does not confuse a value containing the separator with two variables", () => {
    // "A=1\nB=2" as a single value must not look like A=1 plus B=2.
    expect(envSignature({ A: "1\nB=2" })).not.toBe(envSignature({ A: "1", B: "2" }));
  });

  it("fits in a Docker label", () => {
    expect(envSignature({ A: "1" })).toMatch(/^[0-9a-f]{32}$/);
  });
});
