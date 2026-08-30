import { describe, expect, it } from "vitest";
import { DOMAIN_TXT_LABEL } from "@replit-clone/shared";
import {
  assertClaimable,
  normalizeDomain,
  toCustomDomain,
  txtName,
} from "./customDomainService.js";

/** The parts of a custom domain that are decided before anything is stored.
 *
 *  Everything here is a refusal, and the refusals are the feature. A custom
 *  domain is the one address in this product the server did not generate, so
 *  the only thing standing between "a user typed a name" and "we serve their
 *  code at it" is this file and the TXT check. The database tests cover the
 *  second half.
 */
describe("normalizeDomain", () => {
  it("lowercases and drops the trailing dot", () => {
    // Both are the same name. Stored differently they would compare unequal
    // to the Host header on every request, which is a site that mysteriously
    // 404s at the address its owner just verified.
    expect(normalizeDomain("  WWW.Example.COM.  ")).toBe("www.example.com");
  });

  it("takes an ordinary domain", () => {
    expect(normalizeDomain("app.example.co.uk")).toBe("app.example.co.uk");
    expect(normalizeDomain("my-site.example.com")).toBe("my-site.example.com");
  });

  it("says what to do about a pasted URL", () => {
    // Rejecting this as "not a valid hostname" would be true and useless. The
    // person pasted the thing their browser shows them.
    expect(() => normalizeDomain("https://example.com/app")).toThrow(
      /no scheme, port or path/i,
    );
    expect(() => normalizeDomain("example.com:8080")).toThrow(
      /no scheme, port or path/i,
    );
  });

  it("refuses a single label", () => {
    // Not a name anybody owns on the public internet. Accepting one would let
    // a claim be filed against an intranet name that resolves differently for
    // the server than for everyone else.
    expect(() => normalizeDomain("localhost")).toThrow(/at least two labels/i);
    expect(() => normalizeDomain("intranet")).toThrow(/at least two labels/i);
  });

  it("refuses an address", () => {
    expect(() => normalizeDomain("127.0.0.1")).toThrow(/two labels/i);
    expect(() => normalizeDomain("[::1]")).toThrow();
  });

  it("refuses an empty value and an over-long one", () => {
    expect(() => normalizeDomain("   ")).toThrow(/enter a domain/i);
    expect(() => normalizeDomain(`${"a".repeat(300)}.com`)).toThrow(
      /longer than/i,
    );
  });

  it("refuses characters a hostname cannot carry", () => {
    expect(() => normalizeDomain("exa_mple.com")).toThrow(/not a domain/i);
    expect(() => normalizeDomain("exam ple.com")).toThrow();
    expect(() => normalizeDomain("-example.com")).toThrow(/not a domain/i);
  });
});

describe("assertClaimable", () => {
  it("takes a name that has nothing to do with this platform", () => {
    expect(() => {
      assertClaimable("www.example.com");
    }).not.toThrow();
  });

  it("refuses the deploy origin and anything under it", () => {
    // This space is handed out as generated subdomains on the assumption that
    // nothing else can occupy it. A claim here is a collision with an address
    // the server may hand to somebody else tomorrow.
    const host = new URL(
      process.env["DEPLOY_ORIGIN"] ?? "http://localhost:3102",
    ).hostname;

    // Only meaningful when the configured origin is a real name; the default
    // is a single label, which normalizeDomain refuses on its own.
    if (host.includes(".")) {
      expect(() => {
        assertClaimable(host);
      }).toThrow(/belongs to this platform/i);
      expect(() => {
        assertClaimable(`anything.${host}`);
      }).toThrow(/belongs to this platform/i);
    }
  });
});

describe("txtName", () => {
  it("hangs the proof off a dedicated label", () => {
    // Not the apex. A real domain's apex TXT record already carries SPF,
    // DMARC and a pile of vendor tokens, and asking somebody to edit it is
    // asking them to break their mail.
    expect(txtName("example.com")).toBe(`${DOMAIN_TXT_LABEL}.example.com`);
  });
});

describe("toCustomDomain", () => {
  it("is null when nothing is claimed", () => {
    // One check on the client, rather than a rule about which fields happen
    // to be set.
    expect(
      toCustomDomain({
        customDomain: null,
        domainToken: null,
        domainVerifiedAt: null,
        domainCheckedAt: null,
      }),
    ).toBeNull();
  });

  it("reports a claimed but unproved domain as unverified", () => {
    const row = toCustomDomain({
      customDomain: "example.com",
      domainToken: "tok",
      domainVerifiedAt: null,
      domainCheckedAt: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(row).toMatchObject({
      domain: "example.com",
      verified: false,
      verifiedAt: null,
      checkedAt: "2026-08-30T00:00:00.000Z",
      txtValue: "tok",
    });
  });

  it("separates when it was proved from when it was last looked at", () => {
    // The distinction the sweep depends on: "never checked" and "checked and
    // the record was gone" cannot be the same value.
    const row = toCustomDomain({
      customDomain: "example.com",
      domainToken: "tok",
      domainVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      domainCheckedAt: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(row?.verified).toBe(true);
    expect(row?.verifiedAt).toBe("2026-08-29T00:00:00.000Z");
    expect(row?.checkedAt).toBe("2026-08-30T00:00:00.000Z");
  });
});
