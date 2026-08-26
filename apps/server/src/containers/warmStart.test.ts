import { describe, expect, it } from "vitest";
import { planStart, splitStartCommand } from "./warmStart.js";

describe("splitStartCommand", () => {
  it("takes apart the shape every template uses", () => {
    expect(splitStartCommand("npm install && npm run dev")).toEqual({
      install: "npm install",
      serve: "npm run dev",
    });
    expect(
      splitStartCommand("pip install -r requirements.txt && python app.py"),
    ).toEqual({
      install: "pip install -r requirements.txt",
      serve: "python app.py",
    });
  });

  it("leaves a command with no install step alone", () => {
    // Static HTML and Go: nothing to skip, so nothing to take apart.
    expect(splitStartCommand("serve -l 8080 .")).toBeNull();
    expect(splitStartCommand("go run .")).toBeNull();
  });

  it("refuses a left half that is not purely an install", () => {
    // Skipping this would skip the build too.
    expect(splitStartCommand("npm run build && npm start")).toBeNull();
    expect(splitStartCommand("./configure && make")).toBeNull();
  });

  it("refuses a left half that is more than one command", () => {
    expect(
      splitStartCommand("npm install && npm run build && npm start"),
    ).toEqual({
      install: "npm install",
      // Everything after the FIRST && is the serve half, build included.
      serve: "npm run build && npm start",
    });
    expect(splitStartCommand("cd app; npm install && npm start")).toBeNull();
  });

  it("refuses a command it cannot be certain about", () => {
    for (const command of [
      "",
      "&& npm start",
      "npm install &&",
      "npm install || true && npm start",
    ]) {
      expect(splitStartCommand(command)).toBeNull();
    }
  });

  it("does not mistake a similarly named script for an install", () => {
    // `npm run install-deps` is a script the user wrote; it is not npm's own
    // install and may do anything at all.
    expect(splitStartCommand("npm run install-deps && npm start")).toBeNull();
  });
});

describe("planStart", () => {
  const command = "npm install && npm run dev";

  it("skips the install when nothing that decides it has changed", () => {
    const plan = planStart({
      command,
      fingerprint: "abc",
      stamped: "abc",
      installed: true,
    });

    expect(plan).toEqual({
      command: "npm run dev",
      skippedInstall: true,
      fingerprint: "abc",
    });
  });

  it("installs when the fingerprint moved", () => {
    // A dependency added, a lockfile updated, a manifest edited by hand.
    const plan = planStart({
      command,
      fingerprint: "def",
      stamped: "abc",
      installed: true,
    });

    expect(plan.command).toBe(command);
    expect(plan.skippedInstall).toBe(false);
  });

  it("installs when nothing has ever been stamped", () => {
    const plan = planStart({
      command,
      fingerprint: "abc",
      stamped: null,
      installed: true,
    });

    expect(plan.skippedInstall).toBe(false);
  });

  it("installs when the artefacts are gone, however well the stamp matches", () => {
    // Deleting node_modules is a thing people do on purpose, and it has to
    // mean what they intended.
    const plan = planStart({
      command,
      fingerprint: "abc",
      stamped: "abc",
      installed: false,
    });

    expect(plan.command).toBe(command);
    expect(plan.skippedInstall).toBe(false);
  });

  it("runs a command it cannot split exactly as written", () => {
    const plan = planStart({
      command: "go run .",
      fingerprint: "abc",
      stamped: "abc",
      installed: true,
    });

    expect(plan.command).toBe("go run .");
    expect(plan.skippedInstall).toBe(false);
  });

  it("runs in full when the project declares no dependencies", () => {
    // No manifest means no fingerprint, and no basis on which to skip.
    const plan = planStart({
      command,
      fingerprint: null,
      stamped: "abc",
      installed: true,
    });

    expect(plan.command).toBe(command);
    expect(plan.skippedInstall).toBe(false);
    expect(plan.fingerprint).toBeNull();
  });

  it("never skips a run command the user wrote themselves", () => {
    // A project may carry its own; guessing at its shape is how a start
    // silently stops installing.
    const plan = planStart({
      command: "make dev",
      fingerprint: "abc",
      stamped: "abc",
      installed: true,
    });

    expect(plan.skippedInstall).toBe(false);
  });
});
