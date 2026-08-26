import path from "node:path";
import { describe, expect, it } from "vitest";
import { isHiddenPath, resolveWithin } from "./deploySite.js";

/** The public listener's two containment rules.
 *
 *  Everything else on this origin is a stat and a stream. These two decide what
 *  a stranger with a crafted URL can read out of a directory the platform
 *  publishes to the entire internet, so they are tested apart from the server
 *  they run in.
 */

const ROOT = path.resolve("/sites/quiet-fern");

describe("resolveWithin", () => {
  it("resolves an ordinary path under the root", () => {
    expect(resolveWithin(ROOT, "/assets/app.js")).toBe(
      path.join(ROOT, "assets", "app.js"),
    );
  });

  it("treats the root itself as the root", () => {
    expect(resolveWithin(ROOT, "/")).toBe(ROOT);
  });

  it("refuses a traversal", () => {
    expect(resolveWithin(ROOT, "/../../etc/passwd")).toBeUndefined();
    expect(resolveWithin(ROOT, "/assets/../../../secret")).toBeUndefined();
  });

  it("refuses a traversal that only appears once it is decoded", () => {
    // %2e%2e%2f is "../". Checking before decoding would pass this straight
    // through, which is the classic version of this bug.
    expect(resolveWithin(ROOT, "/%2e%2e%2f%2e%2e%2fetc/passwd")).toBeUndefined();
    expect(resolveWithin(ROOT, "/..%2f..%2fetc")).toBeUndefined();
  });

  it("refuses a backslash traversal", () => {
    // A separator on Windows, so it has to be normalised before the check
    // rather than after it.
    expect(resolveWithin(ROOT, "/..\\..\\etc")).toBeUndefined();
  });

  it("refuses a null byte", () => {
    // libuv truncates at NUL, so a prefix check on the whole string would not
    // be checking the path that actually gets opened.
    expect(resolveWithin(ROOT, "/index.html\0.png")).toBeUndefined();
  });

  it("refuses a malformed escape rather than guessing at it", () => {
    expect(resolveWithin(ROOT, "/%zz")).toBeUndefined();
  });

  it("does not let a sibling whose name merely starts the same through", () => {
    expect(resolveWithin(ROOT, "/../quiet-fern-other/x")).toBeUndefined();
  });
});

describe("isHiddenPath", () => {
  it("hides a dotfile that made it into the build output", () => {
    // Vite copies public/ verbatim, so a stray public/.env would otherwise be
    // published and served to anybody who guessed the name.
    expect(isHiddenPath("/.env")).toBe(true);
    expect(isHiddenPath("/assets/.env.production")).toBe(true);
    expect(isHiddenPath("/.git/config")).toBe(true);
  });

  it("leaves .well-known alone", () => {
    // Certificate issuance and app association files live there by
    // specification and are meant to be fetched.
    expect(isHiddenPath("/.well-known/acme-challenge/abc")).toBe(false);
  });

  it("does not mistake a dot inside a name for a hidden file", () => {
    expect(isHiddenPath("/assets/app.9f2c.js")).toBe(false);
    expect(isHiddenPath("/index.html")).toBe(false);
  });
});
