import { beforeEach, describe, expect, it, vi } from "vitest";

/** What has a second person on the other end of it.
 *
 *  The point of gathering this into one module is that it is ONE decision taken
 *  a dozen times, and leaving it implicit is how a personal deployment ends up
 *  shipping a report queue. So these tests are as much about the list's
 *  boundaries as about the switch: what is off, and — more usefully — what is
 *  deliberately still on and why.
 */

const singleUserEnabled = vi.hoisted(() => vi.fn());
vi.mock("../service/singleUserService.js", () => ({
  singleUserEnabled,
  singleUserEmail: vi.fn(),
  assertCanCreateAccount: vi.fn(),
  ensureSingleUser: vi.fn(),
}));

import { capabilities } from "./deploymentMode.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an ordinary deployment", () => {
  it("has all of it", () => {
    singleUserEnabled.mockReturnValue(false);

    // The half that matters most: this file must not quietly take anything
    // away from a deployment that has more than one person on it.
    expect(capabilities()).toEqual({
      sharing: true,
      moderation: true,
      operatorConsole: true,
      gallery: true,
      plans: true,
    });
  });
});

describe("a deployment with one account", () => {
  beforeEach(() => {
    singleUserEnabled.mockReturnValue(true);
  });

  it("has none of it", () => {
    expect(capabilities()).toEqual({
      sharing: false,
      moderation: false,
      operatorConsole: false,
      gallery: false,
      plans: false,
    });
  });

  it("is derived from the account mode rather than being a second flag", () => {
    // Deliberate, and the reason is that none of these is a preference. Each is
    // dead by arithmetic: a share link is redeemed by a second account, a
    // report needs a reporter and a separate operator, the console
    // administers accounts, and the gallery lists what other people published.
    // A flag would imply they could sensibly be switched back on.
    singleUserEnabled.mockReturnValue(false);
    expect(capabilities().sharing).toBe(true);

    singleUserEnabled.mockReturnValue(true);
    expect(capabilities().sharing).toBe(false);
  });
});

describe("what is deliberately not on the list", () => {
  it("says nothing about embeds, deploys, API keys or the assistant", () => {
    singleUserEnabled.mockReturnValue(true);

    // Each of these has a real user at n=1, and the surface is the record of
    // that judgement: putting your own project in your own blog post, serving
    // it at a domain, reaching it from your own build server. §10.5's original
    // list had API keys as dead and that was wrong -- recorded as a deviation
    // rather than followed silently.
    const keys = Object.keys(capabilities()).sort();

    expect(keys).toEqual([
      "gallery",
      "moderation",
      "operatorConsole",
      "plans",
      "sharing",
    ]);
  });
});
