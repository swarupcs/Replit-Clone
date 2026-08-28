import { describe, expect, it } from "vitest";
import {
  domainAllowed,
  egressDecision,
  isPrivateAddress,
  type EgressPolicy,
} from "@replit-clone/shared";

/** The decision the egress gateway makes about every outbound connection a
 *  sandbox attempts.
 *
 *  Tested here rather than beside the gateway because the gateway is a
 *  container on a network that cannot be stood up in a unit test — and a
 *  security rule that can only be exercised that way is one nobody exercises.
 *  The proxy at `images/egress/proxy.mjs` is the socket work; this is what it
 *  asks.
 */

const OPEN: EgressPolicy = { allowDomains: [], allowPorts: [80, 443] };

describe("addresses a sandbox may not reach", () => {
  it.each([
    ["169.254.169.254", "cloud instance metadata, which hands out credentials"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["192.168.1.1", "RFC 1918, the host's own LAN"],
    ["100.64.0.1", "carrier NAT"],
    ["::1", "loopback, v6"],
    ["fe80::1", "link-local, v6"],
    ["fd00::1", "unique-local, v6"],
    ["::ffff:127.0.0.1", "v4 loopback wearing a v6 prefix"],
  ])("refuses %s (%s)", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111"])(
    "allows the public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("refuses anything that is not an address at all", () => {
    // Fails closed. A guard that cannot parse its input must not guess.
    expect(isPrivateAddress("example.com")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
  });
});

describe("the whole decision", () => {
  it("allows a public destination on a permitted port", () => {
    const verdict = egressDecision("registry.npmjs.org", 443, ["104.16.1.35"], OPEN);

    expect(verdict).toEqual({ allowed: true, address: "104.16.1.35" });
  });

  it("returns the address it checked, for the caller to dial", () => {
    // Not the hostname. Approving a name and then handing that name to a
    // socket is exactly what DNS rebinding exploits — the resolver is free to
    // answer differently the second time.
    const verdict = egressDecision("cdn.example.com", 443, ["93.184.216.34"], OPEN);

    expect(verdict.allowed && verdict.address).toBe("93.184.216.34");
  });

  it("refuses a name that resolves onto a private address", () => {
    const verdict = egressDecision("metadata.evil.test", 80, ["169.254.169.254"], OPEN);

    expect(verdict.allowed).toBe(false);
  });

  it("refuses a name that resolves to a public AND a private address", () => {
    // Not a half-safe destination. It is an attack with a fallback: the
    // client picks, and one of the choices is the metadata endpoint.
    const verdict = egressDecision(
      "both.evil.test",
      443,
      ["93.184.216.34", "169.254.169.254"],
      OPEN,
    );

    expect(verdict.allowed).toBe(false);
  });

  it("refuses a name that resolved to nothing", () => {
    expect(egressDecision("nowhere.test", 443, [], OPEN).allowed).toBe(false);
  });

  it("refuses a port that is not permitted", () => {
    // A public address is not automatically a safe destination: 25 from this
    // platform's IP is somebody else's spam problem.
    const verdict = egressDecision("mail.example.com", 25, ["93.184.216.34"], OPEN);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("25");
  });

  it("checks the port before spending a lookup on the host", () => {
    // The caller resolves first, so this is about the message rather than the
    // work — a refusal naming the port is actionable, "private address" is
    // not when the address was never the problem.
    const verdict = egressDecision("mail.example.com", 25, ["10.0.0.1"], OPEN);

    expect(verdict.allowed === false && verdict.reason).toContain("port");
  });
});

describe("the optional domain allowlist", () => {
  const CLOSED: EgressPolicy = {
    allowDomains: ["npmjs.org", "github.com"],
    allowPorts: [443],
  };

  it("is open when empty, because a sandbox that cannot install is not one", () => {
    expect(domainAllowed("anything.example.com", [])).toBe(true);
  });

  it("allows the named domain and anything under it", () => {
    expect(domainAllowed("npmjs.org", CLOSED.allowDomains)).toBe(true);
    expect(domainAllowed("registry.npmjs.org", CLOSED.allowDomains)).toBe(true);
  });

  it("refuses a domain that merely ends with the same letters", () => {
    // The bug a plain `endsWith` has, and the whole reason this is a function.
    expect(domainAllowed("evil-github.com", CLOSED.allowDomains)).toBe(false);
    expect(domainAllowed("notnpmjs.org", CLOSED.allowDomains)).toBe(false);
  });

  it("ignores case and a trailing root dot", () => {
    // Both are how the same name is legitimately written, and both are how a
    // string comparison is evaded.
    expect(domainAllowed("REGISTRY.NPMJS.ORG", CLOSED.allowDomains)).toBe(true);
    expect(domainAllowed("registry.npmjs.org.", CLOSED.allowDomains)).toBe(true);
  });

  it("refuses an allowlisted domain on a private address anyway", () => {
    // The allowlist is a ceiling, never a floor. A name somebody is entitled
    // to reach, pointed at loopback, is still pointed at loopback.
    const verdict = egressDecision(
      "registry.npmjs.org",
      443,
      ["127.0.0.1"],
      CLOSED,
    );

    expect(verdict.allowed).toBe(false);
  });
});
