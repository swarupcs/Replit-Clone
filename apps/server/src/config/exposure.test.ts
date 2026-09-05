import { describe, expect, it } from "vitest";
import { checkExposure, type ExposureConfig } from "./exposure.js";

/** plan.md §11.5.
 *
 *  Every case here is a deployment that starts, serves, logs nothing unusual,
 *  and does not work. That is the whole reason the check exists, and it is
 *  also why these tests assert on the ERRORS rather than on behaviour: there
 *  is no behaviour to observe, because the failure happens inside a browser
 *  that tells neither side it discarded a cookie.
 *
 *  The local default is checked first and hardest. A boot check that refuses
 *  the ordinary development setup is worse than no boot check at all.
 */

/** The arrangement `pnpm dev` produces: one host, three ports. */
const local: ExposureConfig = {
  webOrigin: "http://localhost:15273",
  apiOrigin: "http://localhost:3000",
  previewOrigin: "http://localhost:3101",
  previewOriginDeclared: false,
  deployOrigin: "http://localhost:3102",
  deploymentsEnabled: true,
  cookieDomain: "",
  cookieSameSite: "lax",
  cookieSecure: false,
  trustedProxyHops: 0,
};

/** The arrangement docs/EXPOSING.md produces: three names under one domain,
 *  with published sites deliberately on a second domain. */
const proxied: ExposureConfig = {
  webOrigin: "https://ide.example.com",
  apiOrigin: "https://api.example.com",
  previewOrigin: "https://preview.example.com",
  previewOriginDeclared: true,
  deployOrigin: "https://sites.example.net",
  deploymentsEnabled: true,
  cookieDomain: "example.com",
  cookieSameSite: "lax",
  cookieSecure: true,
  trustedProxyHops: 1,
};

function check(patch: Partial<ExposureConfig>, base = proxied) {
  return checkExposure({ ...base, ...patch });
}

describe("the setups that must pass", () => {
  it("accepts local development without a word", () => {
    expect(checkExposure(local)).toEqual({ errors: [], warnings: [] });
  });

  it("accepts the documented reverse-proxy setup", () => {
    expect(checkExposure(proxied)).toEqual({ errors: [], warnings: [] });
  });

  /** Ports off, one host, previews on the API's own origin -- the trade
   *  PREVIEW_PORT=0 exists to allow. It is less safe and the env file says so,
   *  but it is a supported choice and must not be refused here. */
  it("accepts previews sharing the API's origin", () => {
    expect(
      check(
        {
          previewOrigin: "http://localhost:3000",
          deploymentsEnabled: false,
          deployOrigin: "http://localhost:0",
        },
        local,
      ).errors,
    ).toEqual([]);
  });
});

describe("the cookie policy on its own", () => {
  it("refuses SameSite=None without Secure", () => {
    const { errors } = check({ cookieSameSite: "none", cookieSecure: false });

    expect(errors.join(" ")).toMatch(/SameSite=None cookie that is not Secure/);
  });

  it("refuses Secure cookies on a plain-HTTP origin", () => {
    const { errors } = check({
      webOrigin: "http://ide.example.com",
      apiOrigin: "http://api.example.com",
      previewOrigin: "http://preview.example.com",
      cookieSecure: true,
    });

    expect(errors.some((e) => e.includes("WEB_ORIGIN"))).toBe(true);
    expect(errors.some((e) => e.includes("API_ORIGIN"))).toBe(true);
  });

  /** Browsers exempt loopback by name, so `NODE_ENV=production` locally --
   *  which is how COOKIE_SECURE ends up true -- must not be refused. */
  it("exempts loopback, which browsers treat as secure", () => {
    expect(check({ cookieSecure: true }, local).errors).toEqual([]);
  });
});

describe("the failure a reverse proxy introduces", () => {
  /** The headline. Two names and no COOKIE_DOMAIN means the preview cookie is
   *  host-only to the API and every preview is refused. */
  it("refuses two hostnames with no COOKIE_DOMAIN", () => {
    const { errors } = check({ cookieDomain: "" });

    expect(errors.join(" ")).toMatch(/COOKIE_DOMAIN is unset/);
    expect(errors.join(" ")).toMatch(/every preview would be refused/i);
  });

  /** ...and does not complain when they differ only by port, which is the
   *  case cookies ignore. */
  it("says nothing when the two differ only by port", () => {
    expect(checkExposure(local).errors).toEqual([]);
  });
});

describe("the ways COOKIE_DOMAIN itself is rejected by a browser", () => {
  it("refuses an IP address", () => {
    const { errors } = check({
      webOrigin: "https://10.0.0.5",
      apiOrigin: "https://10.0.0.5",
      previewOrigin: "https://10.0.0.5:3101",
      cookieDomain: "10.0.0.5",
    });

    expect(errors.join(" ")).toMatch(/is an IP address/);
  });

  it("refuses a single label", () => {
    const { errors } = check({
      webOrigin: "https://ide",
      apiOrigin: "https://api",
      previewOrigin: "https://preview",
      cookieDomain: "internal",
    });

    expect(errors.join(" ")).toMatch(/has no dot in it/);
  });

  it("refuses a domain that does not cover the API's host", () => {
    const { errors } = check({ cookieDomain: "elsewhere.com" });

    expect(errors.join(" ")).toMatch(/does not cover API_ORIGIN's host/);
  });

  it("refuses a domain that does not cover the preview host", () => {
    const { errors } = check({
      previewOrigin: "https://preview.example.net",
      cookieDomain: "example.com",
    });

    expect(errors.join(" ")).toMatch(/does not cover the preview origin/);
  });

  /** A cookie the editor's own host does not receive is workable -- the editor
   *  carries a bearer token and never presents this cookie -- so this one is a
   *  warning. It is still almost always a mistake. */
  it("only warns when the editor's host is outside it", () => {
    const report = check({
      webOrigin: "https://ide.example.net",
      cookieDomain: "example.com",
    });

    expect(report.errors).toEqual([]);
    expect(report.warnings.join(" ")).toMatch(/does not cover WEB_ORIGIN/);
  });
});

describe("published sites, which are somebody else's code", () => {
  /** The trade COOKIE_DOMAIN makes, refused rather than noted. Widening the
   *  preview cookie to a shared parent sends it to every sibling name, and a
   *  published site is arbitrary code behind a name this platform hands out --
   *  it receives the cookie on every /preview path and can overwrite it for
   *  the parent domain. */
  it("refuses a deploy origin inside COOKIE_DOMAIN", () => {
    const { errors } = check({ deployOrigin: "https://sites.example.com" });

    expect(errors.join(" ")).toMatch(/covers DEPLOY_ORIGIN's host/);
  });

  it("allows it once deployments are off", () => {
    expect(
      check({
        deployOrigin: "https://sites.example.com",
        deploymentsEnabled: false,
      }).errors,
    ).toEqual([]);
  });

  it("refuses a deploy origin that is the editor's", () => {
    const { errors } = check({
      deployOrigin: "https://ide.example.com",
      cookieDomain: "",
      previewOrigin: "https://ide.example.com",
    });

    expect(errors.join(" ")).toMatch(/DEPLOY_ORIGIN and WEB_ORIGIN/);
  });

  it("refuses a deploy origin that is the preview origin", () => {
    const { errors } = check({ deployOrigin: "https://preview.example.com" });

    expect(errors.join(" ")).toMatch(/DEPLOY_ORIGIN and the preview origin/);
  });
});

describe("previews and the editor", () => {
  it("refuses previews on the editor's own origin", () => {
    const { errors } = check({ previewOrigin: "https://ide.example.com" });

    expect(errors.join(" ")).toMatch(
      /preview origin and WEB_ORIGIN are the same origin/,
    );
  });
});

describe("what it merely warns about", () => {
  it("notices a mixed pair of schemes", () => {
    const { warnings } = check({
      webOrigin: "http://ide.example.com",
      cookieSecure: false,
    });

    expect(warnings.join(" ")).toMatch(/do not use the same scheme/);
  });

  /** Nothing can prove a proxy is there at boot; HTTPS with zero hops is the
   *  shape of one that was forgotten. The runtime half of this lives in
   *  `middlewares/proxyHeaderWarning.ts`, which waits for the evidence. */
  it("notices HTTPS with no trusted proxy hops", () => {
    const { warnings } = check({ trustedProxyHops: 0 });

    expect(warnings.join(" ")).toMatch(/TRUSTED_PROXY_HOPS=0/);
  });

  it("notices an HTTPS deployment that never declared PREVIEW_ORIGIN", () => {
    const { warnings } = check({ previewOriginDeclared: false });

    expect(warnings.join(" ")).toMatch(/PREVIEW_ORIGIN is unset/);
  });

  it("says nothing about proxy hops on a plain-HTTP deployment", () => {
    expect(checkExposure(local).warnings).toEqual([]);
  });
});
