import { execFileSync } from "node:child_process";
import { hasBash } from "../test/capabilities.js";
import { describe, expect, it } from "vitest";
import {
  PGID_MARKER,
  shellQuote,
  takeProcessGroupId,
  type RunSession,
} from "./runner.js";

function session(): RunSession {
  return { state: { status: "starting" }, history: [] };
}

/** Runs `bash -lc` on the quoted word, the way startRun's launcher does, and
 *  returns what the inner shell actually received. */
function roundTrip(value: string): string {
  return execFileSync("/bin/bash", ["-lc", `printf '%s' ${shellQuote(value)}`], {
    encoding: "utf8",
  });
}

// These exec a real bash and compare what it actually received, which is the
// only way to know the quoting holds. Without a POSIX shell they cannot run.
describe.skipIf(!hasBash)("shellQuote", () => {
  it.each([
    ["a plain command", "npm run dev"],
    ["shell operators", "npm install && npm run dev"],
    ["a pipe", "cat x | grep y"],
    ["an embedded single quote", "echo 'hi there'"],
    ["a double quote", 'echo "hi"'],
    ["a dollar sign, which must not expand", "echo $HOME"],
    ["command substitution, which must not run", "echo $(whoami)"],
    ["a backtick", "echo `id`"],
    ["a semicolon", "echo a; echo b"],
    ["a backslash", "echo a\\b"],
  ])("survives %s unchanged", (_label, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("does not let a crafted command escape its quoting", () => {
    // If quoting were wrong this would run `id` and leak into the output.
    const hostile = "'; id; echo '";
    expect(roundTrip(hostile)).toBe(hostile);
  });
});

describe("takeProcessGroupId", () => {
  it("captures the id and hides the marker line", () => {
    const current = session();
    const visible = takeProcessGroupId(current, `${PGID_MARKER}4242\n> vite dev\n`);

    expect(current.pgid).toBe("4242");
    expect(visible).toBe("> vite dev\n");
  });

  it("handles a carriage return before the newline, as a TTY emits", () => {
    const current = session();
    takeProcessGroupId(current, `${PGID_MARKER}77\r\nout`);

    expect(current.pgid).toBe("77");
  });

  it("reassembles a marker split across two chunks", () => {
    const current = session();

    expect(takeProcessGroupId(current, `${PGID_MARKER.slice(0, 6)}`)).toBe("");
    expect(current.pgid).toBeUndefined();

    const visible = takeProcessGroupId(
      current,
      `${PGID_MARKER.slice(6)}512\nbuilding\n`,
    );
    expect(current.pgid).toBe("512");
    expect(visible).toBe("building\n");
  });

  it("passes output straight through once the id is known", () => {
    const current = session();
    takeProcessGroupId(current, `${PGID_MARKER}9\n`);

    expect(takeProcessGroupId(current, "later output")).toBe("later output");
  });

  it("releases held output rather than swallowing a log that never marks", () => {
    const current = session();
    const noisy = "x".repeat(5000);
    const visible = takeProcessGroupId(current, noisy);

    expect(current.pgid).toBeUndefined();
    expect(visible).toBe(noisy);
  });

  it("does not mistake ordinary output for the marker", () => {
    const current = session();
    const visible = takeProcessGroupId(current, "compiled __rc_pgid__ ok\n");

    expect(current.pgid).toBeUndefined();
    expect(visible).toBe("");
  });
});
