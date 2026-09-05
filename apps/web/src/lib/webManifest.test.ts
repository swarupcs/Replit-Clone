import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The manifest and the icons beside it. plan.md §11.7.
 *
 *  These are static files that nothing imports, which is exactly why they need
 *  a test: nothing else in this repository would ever notice if the manifest
 *  named an icon that had been renamed, or declared a size the PNG does not
 *  have. Both are silent failures — an install prompt that never appears, or
 *  an icon the OS scales badly — and neither shows up in development, because
 *  the service worker is off there and nobody installs a dev server.
 *
 *  The sizes are read out of each PNG's IHDR rather than trusted, so this
 *  compares the manifest against the actual bytes.
 */

const PUBLIC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public",
);

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

const manifest = JSON.parse(
  readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8"),
) as Manifest;

/** Width and height from a PNG's IHDR, which is at a fixed offset. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(path.join(PUBLIC, file));

  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the web manifest", () => {
  it("is valid JSON with the fields an install needs", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  /** The colour behind the splash screen and around the window. A mismatch
   *  with the app's own ground shows as a flash of the wrong colour on every
   *  launch. */
  it("uses the app's own background colour", () => {
    expect(manifest.background_color).toBe("#08090f");
    expect(manifest.theme_color).toBe("#08090f");
  });

  it("is referenced from the document", () => {
    const html = readFileSync(path.join(PUBLIC, "../index.html"), "utf8");

    expect(html).toContain('rel="manifest"');
    expect(html).toContain("/manifest.webmanifest");
    // iOS reads none of the manifest's icons and takes only this one.
    expect(html).toContain('rel="apple-touch-icon"');
  });
});

describe("the icons it names", () => {
  it("all exist, and are the size the manifest claims", () => {
    for (const icon of manifest.icons) {
      const { width, height } = pngSize(icon.src.replace(/^\//, ""));

      expect(`${String(width)}x${String(height)}`).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    }
  });

  /** Android needs both. Without a `maskable` one it applies its own mask to
   *  the `any` icon and crops the artwork; without an `any` one, every other
   *  surface gets an icon designed to be cropped and shows it with the safe
   *  padding still around it. */
  it("offers both an ordinary and a maskable icon", () => {
    const purposes = manifest.icons.map((icon) => icon.purpose);

    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");
  });

  it("includes the 192 and 512 an install prompt looks for", () => {
    const sizes = manifest.icons
      .filter((icon) => icon.purpose === "any")
      .map((icon) => icon.sizes);

    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("ships the apple-touch-icon the document points at", () => {
    expect(pngSize("apple-touch-icon.png").width).toBe(180);
  });
});

describe("the service worker", () => {
  const source = readFileSync(path.join(PUBLIC, "sw.js"), "utf8");

  /** The three refusals that make this safe to ship. A cached `/api/` response
   *  is a lie about somebody's data — and a cached 200 for a request that
   *  should have 401'd is a security bug, not a stale page. */
  it("never caches the API, previews or the socket", () => {
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('url.pathname.startsWith("/preview/")');
    expect(source).toContain('url.pathname.startsWith("/socket.io/")');
  });

  it("only ever handles GET", () => {
    expect(source).toContain('request.method !== "GET"');
  });

  it("refuses cross-origin responses", () => {
    expect(source).toContain("url.origin !== self.location.origin");
    // An opaque response cached here would be indistinguishable from a working
    // one on the next load.
    expect(source).toContain('response.type === "basic"');
  });

  /** Network-first for navigations, or a deploy would never reach anybody who
   *  has visited before. */
  it("puts the network first for navigations", () => {
    const navigate = source.indexOf('request.mode === "navigate"');
    expect(navigate).toBeGreaterThan(-1);
    expect(source.indexOf("fetch(request)", navigate)).toBeGreaterThan(navigate);
  });
});
