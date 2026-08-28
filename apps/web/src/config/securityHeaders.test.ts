import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_HEADERS, EMBED_HEADERS, headersFor } from "./securityHeaders.ts";

/** The headers, and the guard against the two servers drifting apart.
 *
 *  This app is delivered by Vite in development and by nginx in the image.
 *  A header present in one and missing from the other is worse than one
 *  missing from both: it works on the machine of whoever added it and is
 *  absent in the only place an attacker sees. Nothing makes nginx read a TS
 *  module, so the next best thing is a test that fails when they disagree.
 */

const nginx = readFileSync(
  fileURLToPath(new URL("../../nginx.conf", import.meta.url)),
  "utf8",
);

describe("what the app origin says about itself", () => {
  it("refuses to be framed at all", () => {
    // The whole point. A page that could frame this is showing a real IDE,
    // with the reader's real session, under markup of its own choosing.
    expect(APP_HEADERS["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(APP_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  it("says it twice, for browsers that read only the older header", () => {
    // They say the same thing; one of them is understood everywhere.
    expect(Object.keys(APP_HEADERS)).toContain("X-Frame-Options");
    expect(Object.keys(APP_HEADERS)).toContain("Content-Security-Policy");
  });

  it("does not police scripts, because that would break Monaco", () => {
    // Monaco loads workers from blob: URLs and its TypeScript worker needs
    // eval. A script policy here is a white editor, not a secure one — and a
    // policy added later without knowing that would look correct in review.
    expect(APP_HEADERS["Content-Security-Policy"]).not.toContain("script-src");
    expect(APP_HEADERS["Content-Security-Policy"]).not.toContain("default-src");
  });
});

describe("what an embed says", () => {
  it("says nothing about framing, because being framed is the feature", () => {
    expect(EMBED_HEADERS["Content-Security-Policy"]).not.toContain(
      "frame-ancestors",
    );
    expect(EMBED_HEADERS["X-Frame-Options"]).toBeUndefined();
  });

  it("keeps everything else the app sets", () => {
    // Dropped rather than loosened: only the framing rule differs.
    expect(EMBED_HEADERS["X-Content-Type-Options"]).toBe(
      APP_HEADERS["X-Content-Type-Options"],
    );
    expect(EMBED_HEADERS["Referrer-Policy"]).toBe(APP_HEADERS["Referrer-Policy"]);
    expect(EMBED_HEADERS["Content-Security-Policy"]).toContain("base-uri 'self'");
    expect(EMBED_HEADERS["Content-Security-Policy"]).toContain("object-src 'none'");
  });
});

describe("which set a path gets", () => {
  it.each(["/", "/login", "/project/abc", "/join", "/embedded-but-not"])(
    "refuses framing for %s",
    (pathname) => {
      expect(headersFor(pathname)).toBe(APP_HEADERS);
    },
  );

  it("allows framing only under /embed/", () => {
    expect(headersFor("/embed/abc")).toBe(EMBED_HEADERS);
  });

  it("does not treat a path merely starting with the word as an embed", () => {
    // "/embedding-guide" is a normal page. The trailing slash is what makes
    // this a path segment rather than a prefix of a word.
    expect(headersFor("/embedding-guide")).toBe(APP_HEADERS);
  });
});

describe("nginx serves the same thing Vite does", () => {
  /** These are source assertions, which are a weak way to test behaviour. The
   *  real check was a running nginx: every path below was requested against
   *  the actual image and its headers compared with the dev server's. What
   *  these hold in place is the part that was WRONG the first time.
   */

  it("sends the app's policy and its framing refusal", () => {
    expect(nginx).toContain(APP_HEADERS["Content-Security-Policy"]);
    expect(nginx).toContain(EMBED_HEADERS["Content-Security-Policy"]);
  });

  it("decides the policy from the original URI, not the rewritten one", () => {
    // The bug this replaced, and the reason a `location ^~ /embed/` block is
    // not enough. This is an SPA: every route falls through `try_files` to
    // /index.html, and that internal rewrite RE-RUNS location matching -- so
    // /embed/abc left the embed block, landed back in `location /`, and was
    // served `frame-ancestors 'none'`. Every embed would have gone blank in
    // production while testing correct in the dev server.
    expect(nginx).toMatch(/map \$request_uri \$rc_csp/);
    expect(nginx).toMatch(/map \$request_uri \$rc_frame_options/);
    // `$request_uri` is the untouched original. `$uri` is not, and swapping
    // one for the other reintroduces the bug silently.
    expect(nginx).not.toMatch(/map \$uri \$rc_/);
  });

  it("matches /embed/ as a path segment rather than a word prefix", () => {
    // So /embedding-guide is a normal page, exactly as headersFor says.
    expect(nginx).toMatch(/~\^\/embed\//);
  });

  it("repeats the headers in every block rather than setting them once", () => {
    // nginx's `add_header` does not inherit into a block that adds any header
    // of its own, so one outer copy would silently vanish from exactly the
    // responses that need it.
    const occurrences = nginx.match(/add_header X-Content-Type-Options/g);
    expect(occurrences?.length).toBe(2);
  });
});
