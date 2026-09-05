import { afterEach, describe, expect, it, vi } from "vitest";

/** plan.md §11.5.
 *
 *  Two assertions carry this file, and they are opposites: the preview cookie
 *  MUST take COOKIE_DOMAIN, because it is the only one that has to reach a
 *  different hostname, and the refresh cookie MUST NOT, because widening a
 *  session credential to every sibling name buys nothing and costs the whole
 *  point of scoping it.
 *
 *  Read through a fresh import each time, since `config/env.ts` reads the
 *  environment once at module load.
 */

const ORIGINAL = { ...process.env };

async function cookiesWith(
  patch: Record<string, string | undefined>,
): Promise<typeof import("./sessionCookies.js")> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  return import("./sessionCookies.js");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("the preview cookie", () => {
  it("carries COOKIE_DOMAIN, which is the only reason it exists", async () => {
    const { previewCookieOptions } = await cookiesWith({
      COOKIE_DOMAIN: "example.com",
    });

    expect(previewCookieOptions.domain).toBe("example.com");
    expect(previewCookieOptions.path).toBe("/preview");
  });

  /** Host-only by default. An unset COOKIE_DOMAIN must produce NO Domain
   *  attribute rather than an empty one, which express would emit as
   *  `Domain=` and browsers would reject. */
  it("is host-only when COOKIE_DOMAIN is unset", async () => {
    const { previewCookieOptions } = await cookiesWith({
      COOKIE_DOMAIN: undefined,
    });

    expect(previewCookieOptions.domain).toBeUndefined();
  });
});

describe("the refresh cookie", () => {
  it("stays host-only even when COOKIE_DOMAIN is set", async () => {
    const { refreshCookieOptions } = await cookiesWith({
      COOKIE_DOMAIN: "example.com",
    });

    expect(refreshCookieOptions.domain).toBeUndefined();
    expect(refreshCookieOptions.path).toBe("/api/v1/auth");
  });

  it("is httpOnly, like the preview cookie", async () => {
    const { previewCookieOptions, refreshCookieOptions } = await cookiesWith({});

    expect(refreshCookieOptions.httpOnly).toBe(true);
    expect(previewCookieOptions.httpOnly).toBe(true);
  });
});
