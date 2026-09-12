import { describe, expect, it } from "vitest";
import { decide } from "./pullRequestEvent.js";

const SHA = "a".repeat(40);

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { name: "widget", owner: { login: "acme" } },
    pull_request: {
      number: 7,
      title: "Add a thing",
      head: { ref: "feature", sha: SHA, repo: { name: "widget", owner: { login: "acme" } } },
      base: { repo: { name: "widget", owner: { login: "acme" } } },
    },
    ...overrides,
  };
}

describe("deciding what a pull request delivery means", () => {
  it("builds a workspace for an opened pull request", () => {
    const decision = decide("pull_request", pullRequest());
    expect(decision).toMatchObject({
      kind: "upsert",
      repo: { owner: "acme", repo: "widget" },
      pull: { number: 7, headRef: "feature", headSha: SHA },
    });
  });

  it.each(["reopened", "synchronize", "ready_for_review"])("acts on %s", (action) => {
    expect(decide("pull_request", pullRequest({ action })).kind).toBe("upsert");
  });

  it.each(["labeled", "assigned", "edited", "review_requested"])(
    "ignores %s, which does not change the code",
    (action) => {
      expect(decide("pull_request", pullRequest({ action })).kind).toBe("ignore");
    },
  );

  it("tears down on close, and knows whether it merged", () => {
    const pr = pullRequest({ action: "closed" }) as Record<string, unknown>;
    (pr.pull_request as Record<string, unknown>).merged = true;
    expect(decide("pull_request", pr)).toMatchObject({ kind: "teardown", number: 7, merged: true });
  });

  it("tears down a pull request closed without merging", () => {
    expect(decide("pull_request", pullRequest({ action: "closed" }))).toMatchObject({
      kind: "teardown",
      merged: false,
    });
  });

  it("REFUSES a pull request from a fork", () => {
    // The security decision in this row: building one means running a
    // stranger's code on this host, which is what §6 decision 13 refused.
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { head: { repo: unknown } }).head.repo = {
      name: "widget",
      owner: { login: "somebody-else" },
    };
    expect(decide("pull_request", pr)).toMatchObject({
      kind: "ignore",
      why: "pull request from a fork",
    });
  });

  it("refuses a pull request whose head repo is missing", () => {
    // Absent is not the same as same-origin, and treating it as such would
    // make the fork refusal skippable by omitting a field.
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { head: { repo?: unknown } }).head.repo = undefined;
    expect(decide("pull_request", pr).kind).toBe("ignore");
  });

  it("refuses a head ref that could be read as an option", () => {
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { head: { ref: string } }).head.ref = "--upload-pack=evil";
    expect(decide("pull_request", pr).kind).toBe("ignore");
  });

  it("refuses a head ref containing ..", () => {
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { head: { ref: string } }).head.ref = "a/../../etc";
    expect(decide("pull_request", pr).kind).toBe("ignore");
  });

  it("refuses a sha that is not one", () => {
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { head: { sha: string } }).head.sha = "not-a-sha";
    expect(decide("pull_request", pr).kind).toBe("ignore");
  });

  it("bounds a title somebody else wrote", () => {
    const pr = pullRequest() as Record<string, unknown>;
    (pr.pull_request as { title: string }).title = "x".repeat(5000);
    const decision = decide("pull_request", pr);
    if (decision.kind !== "upsert") throw new Error("expected upsert");
    expect(decision.pull.title.length).toBe(200);
  });
});

describe("deciding what a push means", () => {
  const push = (overrides: Record<string, unknown> = {}) => ({
    ref: "refs/heads/feature",
    after: SHA,
    repository: { name: "widget", owner: { login: "acme" } },
    ...overrides,
  });

  it("is §12.2's missing trigger, with a reason attached", () => {
    expect(decide("push", push())).toMatchObject({
      kind: "rebuild",
      repo: { owner: "acme", repo: "widget" },
      branch: "feature",
      sha: SHA,
    });
  });

  it("ignores a tag push", () => {
    expect(decide("push", push({ ref: "refs/tags/v1" })).kind).toBe("ignore");
  });

  it("ignores a deleted branch", () => {
    expect(decide("push", push({ deleted: true })).kind).toBe("ignore");
  });

  it("ignores the all-zero sha, which is how a deletion arrives without the flag", () => {
    expect(decide("push", push({ after: "0".repeat(40) })).kind).toBe("ignore");
  });
});

describe("deliveries that are not work", () => {
  it("answers a ping", () => {
    expect(decide("ping", { zen: "hi" }).kind).toBe("ping");
  });

  it("ignores an event this product does not handle", () => {
    expect(decide("issues", { action: "opened" }).kind).toBe("ignore");
  });

  it("ignores a payload that is not an object", () => {
    expect(decide("pull_request", "nope").kind).toBe("ignore");
  });

  it("ignores an unusable repository name", () => {
    expect(
      decide("pull_request", pullRequest({ repository: { name: "../etc", owner: { login: "acme" } } }))
        .kind,
    ).toBe("ignore");
  });
});
