import { describe, expect, it } from "vitest";
import {
  describeFailure,
  loaderFor,
  previewDocument,
  resolveRelative,
} from "./browserBundler.ts";

/** The bundler itself needs a WebAssembly runtime and a network; what is
 *  tested here is every decision made AROUND it, which is where the bugs are:
 *  extension resolution, the document the iframe runs, and the one failure
 *  that is not about the code. */

const FILES = {
  "src/main.tsx": "",
  "src/App.tsx": "",
  "src/lib/index.ts": "",
  "src/styles.css": "",
};

describe("resolving an import out of the project", () => {
  it("finds a file whose extension the import omits", () => {
    // `./App` means `./App.tsx` in every project written the ordinary way. A
    // resolver that only tried the literal path would fail on all of them.
    expect(resolveRelative("src/main.tsx", "./App", FILES)).toBe("src/App.tsx");
  });

  it("finds a directory's index", () => {
    expect(resolveRelative("src/main.tsx", "./lib", FILES)).toBe("src/lib/index.ts");
  });

  it("takes an exact path when there is one", () => {
    expect(resolveRelative("src/main.tsx", "./styles.css", FILES)).toBe(
      "src/styles.css",
    );
  });

  it("climbs out of a directory", () => {
    expect(resolveRelative("src/lib/index.ts", "../App", FILES)).toBe("src/App.tsx");
  });

  it("is null for something that is not there, rather than guessing", () => {
    // The caller turns this into "Could not find ./Missing imported by
    // src/main.tsx", which is the sentence somebody can act on.
    expect(resolveRelative("src/main.tsx", "./Missing", FILES)).toBeNull();
  });
});

describe("which loader a file needs", () => {
  it("knows the ones that are not JavaScript", () => {
    expect(loaderFor("a.tsx")).toBe("tsx");
    expect(loaderFor("a.ts")).toBe("ts");
    expect(loaderFor("a.jsx")).toBe("jsx");
    expect(loaderFor("a.css")).toBe("css");
    expect(loaderFor("a.json")).toBe("json");
  });

  it("falls back to js", () => {
    expect(loaderFor("a.mjs")).toBe("js");
  });
});

describe("the document the iframe runs", () => {
  it("keeps the author's html and puts the bundle in it", () => {
    const html = '<!doctype html><html><body><div id="app"></div></body></html>';
    const out = previewDocument("console.log(1)", html);

    // Their root element is where their app mounts; a generated shell would
    // render nothing for every project that does not use `#root`.
    expect(out).toContain('<div id="app">');
    expect(out).toContain("console.log(1)");
  });

  it("removes the author's module script", () => {
    // It points at a path only their dev server can serve, so leaving it
    // produces a 404 in the iframe beside a working bundle.
    const html =
      '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
    const out = previewDocument("BUNDLE", html);

    expect(out).not.toContain("/src/main.tsx");
    expect(out).toContain("BUNDLE");
  });

  it("makes a shell when the project has no html", () => {
    const out = previewDocument("BUNDLE");
    expect(out).toContain('<div id="root">');
    expect(out).toContain("BUNDLE");
  });

  it("appends when there is no closing body tag", () => {
    expect(previewDocument("BUNDLE", "<div>fragment</div>")).toContain("BUNDLE");
  });
});

describe("explaining a failure", () => {
  it("names the CDN when the browser could not reach it", () => {
    // "Could not resolve react" sends somebody to look at their imports, which
    // is the one place the problem is not.
    expect(describeFailure(new Error("Failed to fetch"))).toContain("esm.sh");
    expect(describeFailure(new Error("Failed to fetch"))).toContain(
      "container preview",
    );
  });

  it("passes esbuild's own message through otherwise", () => {
    expect(describeFailure(new Error("Unexpected token }"))).toBe(
      "Unexpected token }",
    );
  });

  it("copes with something that is not an Error", () => {
    expect(describeFailure("plain string")).toBe("plain string");
  });
});
