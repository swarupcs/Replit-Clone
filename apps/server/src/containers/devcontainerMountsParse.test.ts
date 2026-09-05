import { describe, expect, it } from "vitest";
import { MOUNT_POINT } from "./containerManager.js";
import { interpret } from "./devcontainer.js";

/** Reading `mounts`, and the gate in front of it.
 *
 *  Pure: whether a mount is ALLOWED is a question about the host and lives in
 *  devcontainerMounts.test.ts. This is only about what the file said and
 *  whether this account was permitted to be asked.
 */

const ALLOW = { mounts: true };

function read(raw: Record<string, unknown>, allowed = ALLOW) {
  return interpret(raw, "devcontainer.json", allowed);
}

describe("the gate", () => {
  /** The default is nothing granted, so a call site that forgets to ask gets
   *  the behaviour that existed before mounts did. */
  it("ignores mounts entirely when the caller says nothing", () => {
    const config = interpret(
      { mounts: ["source=/data,target=/data,type=bind"] },
      "devcontainer.json",
    );

    expect(config.mounts).toBeUndefined();
  });

  /** A key that is refused has to SAY it was refused. Silently dropping it is
   *  how somebody spends an afternoon wondering why their directory is empty —
   *  which is the reason `unsupported` exists at all. */
  it("reports mounts as unsupported when they are not permitted", () => {
    const config = interpret(
      { mounts: ["source=/data,target=/data,type=bind"] },
      "devcontainer.json",
      { mounts: false },
    );

    expect(config.unsupported.map((entry) => entry.key)).toContain("mounts");
  });

  /** And must NOT say so when they were honoured, or the screen contradicts
   *  the container. */
  it("does not report them as unsupported when they are permitted", () => {
    const config = read({ mounts: ["source=/data,target=/data,type=bind"] });

    expect(config.unsupported.map((entry) => entry.key)).not.toContain("mounts");
  });
});

describe("the two forms the spec allows", () => {
  it("reads the string form", () => {
    const config = read({
      mounts: ["source=/host/data,target=/data,type=bind"],
    });

    expect(config.mounts).toEqual([
      { type: "bind", source: "/host/data", target: "/data", readOnly: false },
    ]);
  });

  it("reads the object form", () => {
    const config = read({
      mounts: [{ source: "/host/data", target: "/data", type: "bind" }],
    });

    expect(config.mounts?.[0]?.source).toBe("/host/data");
  });

  /** Docker's own aliases, which real configs use interchangeably. */
  it("accepts src and dst as well as source and target", () => {
    const config = read({ mounts: ["src=/host/data,dst=/data"] });

    expect(config.mounts?.[0]).toMatchObject({
      source: "/host/data",
      target: "/data",
    });
  });

  /** Docker defaults an unnamed type to bind, so the shorthand that real
   *  configs use should not be refused for saying less. */
  it("defaults the type to bind", () => {
    const config = read({ mounts: ["source=/host/data,target=/data"] });

    expect(config.mounts?.[0]?.type).toBe("bind");
  });

  it("reads a single mount that is not in an array", () => {
    const config = read({ mounts: "source=/host/data,target=/data" });

    expect(config.mounts).toHaveLength(1);
  });

  it("carries readonly through", () => {
    const config = read({
      mounts: ["source=/host/data,target=/data,readonly=true"],
    });

    expect(config.mounts?.[0]?.readOnly).toBe(true);
  });
});

describe("the variables", () => {
  /** By far the most common thing a real config puts here, so refusing it
   *  would fail the ordinary case. */
  it("expands localWorkspaceFolder to the workspace", () => {
    const config = read({
      mounts: ["source=${localWorkspaceFolder}/.cache,target=/cache"],
    });

    expect(config.mounts?.[0]?.source).toBe(`${MOUNT_POINT}/.cache`);
  });

  /** Deliberately NOT expanded. It would let a file in a repository read this
   *  server's environment, which is where the database URL and every secret
   *  lives, and no amount of path confinement afterwards makes that safe —
   *  it is left as literal text, which then fails to resolve. */
  it("leaves localEnv alone rather than reading the server's environment", () => {
    const config = read({
      mounts: ["source=${localEnv:HOME}/.aws,target=/aws"],
    });

    expect(config.mounts?.[0]?.source).toBe("${localEnv:HOME}/.aws");
  });
});

describe("what it refuses to parse at all", () => {
  /** A malformed mount is the user's mistake to see. This throws rather than
   *  collecting, because unlike a mount that is merely not permitted, there is
   *  nothing here to act on later. */
  it("refuses an entry with no target", () => {
    expect(() => read({ mounts: ["source=/host/data"] })).toThrow(
      /source and a target/,
    );
  });

  it("refuses an entry that is not key=value", () => {
    expect(() => read({ mounts: ["just some text"] })).toThrow(/key=value/);
  });

  it("refuses an entry that is neither a string nor an object", () => {
    expect(() => read({ mounts: [42] })).toThrow(/strings or objects/);
  });
});
