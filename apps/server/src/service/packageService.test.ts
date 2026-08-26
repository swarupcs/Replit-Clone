import { describe, expect, it } from "vitest";
import {
  addArgv,
  assertValidName,
  assertValidVersion,
  editRequirements,
  parseGoMod,
  parsePackageJson,
  parseRequirements,
  removeArgv,
} from "./packageService.js";

describe("parsePackageJson", () => {
  it("reads both sections and marks which is which", () => {
    const entries = parsePackageJson(
      JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^6.1.0" },
      }),
    );

    expect(entries).toEqual([
      { name: "react", version: "^19.0.0" },
      { name: "vite", version: "^6.1.0", dev: true },
    ]);
  });

  it("keeps the range exactly as written", () => {
    const [entry] = parsePackageJson(
      JSON.stringify({ dependencies: { zod: ">=3.0.0 <4" } }),
    );

    // Normalising it would misreport what the project has actually pinned.
    expect(entry?.version).toBe(">=3.0.0 <4");
  });

  it("returns nothing for a manifest being typed in", () => {
    // Half-written JSON is the normal state of a file someone is editing, not
    // an error the panel should surface.
    expect(parsePackageJson('{ "dependencies": {')).toEqual([]);
  });

  it("ignores a dependency whose value is not a string", () => {
    const entries = parsePackageJson(
      JSON.stringify({ dependencies: { good: "1.0.0", bad: { from: "git" } } }),
    );

    expect(entries).toEqual([{ name: "good", version: "1.0.0" }]);
  });
});

describe("parseRequirements", () => {
  it("reads names with and without a specifier", () => {
    expect(parseRequirements("flask\nrequests==2.31.0\n")).toEqual([
      { name: "flask", version: "" },
      { name: "requests", version: "==2.31.0" },
    ]);
  });

  it("skips comments, blanks and flags", () => {
    const raw = "# pinned for CI\n\n-r base.txt\n-e .\nflask>=3\n";

    expect(parseRequirements(raw)).toEqual([{ name: "flask", version: ">=3" }]);
  });

  it("skips a requirement that names a location", () => {
    // A URL or a VCS ref is left alone rather than listed as something the
    // panel could remove, because removing it by name would not work.
    const raw = "app @ git+https://example.com/a.git\nflask\n";

    expect(parseRequirements(raw)).toEqual([{ name: "flask", version: "" }]);
  });

  it("drops an inline comment without dropping the requirement", () => {
    expect(parseRequirements("flask==3.0  # web\n")).toEqual([
      { name: "flask", version: "==3.0" },
    ]);
  });
});

describe("parseGoMod", () => {
  it("reads a require block", () => {
    const raw = [
      "module example.com/app",
      "",
      "go 1.22",
      "",
      "require (",
      "\tgithub.com/go-chi/chi/v5 v5.0.12",
      "\tgolang.org/x/text v0.14.0 // indirect",
      ")",
    ].join("\n");

    expect(parseGoMod(raw)).toEqual([
      { name: "github.com/go-chi/chi/v5", version: "v5.0.12" },
      { name: "golang.org/x/text", version: "v0.14.0" },
    ]);
  });

  it("reads a single-line require", () => {
    expect(parseGoMod("require github.com/a/b v1.2.3\n")).toEqual([
      { name: "github.com/a/b", version: "v1.2.3" },
    ]);
  });

  it("does not mistake the module or go lines for requirements", () => {
    expect(parseGoMod("module example.com/app\ngo 1.22\n")).toEqual([]);
  });
});

describe("assertValidName", () => {
  it("accepts an ordinary name and a scoped one", () => {
    expect(assertValidName("npm", "react")).toBe("react");
    expect(assertValidName("npm", "@tanstack/react-query")).toBe(
      "@tanstack/react-query",
    );
  });

  it("accepts a Go module path", () => {
    expect(assertValidName("go", "github.com/go-chi/chi/v5")).toBe(
      "github.com/go-chi/chi/v5",
    );
  });

  it("refuses a name that is really a flag", () => {
    // Reaches the manager as one argv entry, and the manager would read it as
    // an option rather than a package.
    expect(() => assertValidName("npm", "--registry=http://evil")).toThrow(
      /cannot start with a dash/i,
    );
  });

  it("refuses a name that is really a location", () => {
    // npm installs happily from a path, a tarball URL or a git remote, and any
    // of those would be arbitrary code fetched into the sandbox.
    for (const attempt of [
      "../../etc/passwd",
      "https://example.com/evil.tgz",
      "git+ssh://example.com/a.git",
      "./local-thing",
    ]) {
      expect(() => assertValidName("npm", attempt)).toThrow(/not a npm package/i);
    }
  });

  it("refuses a Go path that climbs", () => {
    expect(() => assertValidName("go", "github.com/../../x")).toThrow(
      /not a go package/i,
    );
  });

  it("refuses a pip name carrying a slash", () => {
    expect(() => assertValidName("pip", "evil/../thing")).toThrow(
      /not a pip package/i,
    );
  });
});

describe("assertValidVersion", () => {
  it("accepts ranges, pins and tags", () => {
    for (const version of ["1.2.3", "^19.0.0", ">=3,<4", "latest", "v1.9.0"]) {
      expect(assertValidVersion(version)).toBe(version);
    }
  });

  it("treats nothing as latest", () => {
    expect(assertValidVersion("   ")).toBe("");
  });

  it("refuses anything that could name a location", () => {
    for (const version of [
      "1.0.0 && rm -rf /",
      "git+https://example.com/a.git",
      "file:../x",
    ]) {
      expect(() => assertValidVersion(version)).toThrow(/not a version/i);
    }
  });
});

describe("the command each ecosystem is given", () => {
  it("installs at a version, or at latest when none was asked for", () => {
    expect(addArgv("npm", "react", "19.0.0", false)).toEqual([
      "npm",
      "install",
      "react@19.0.0",
    ]);
    expect(addArgv("npm", "react", "", false)).toEqual([
      "npm",
      "install",
      "react",
    ]);
  });

  it("passes npm's dev flag only when asked", () => {
    expect(addArgv("npm", "vite", "", true)).toContain("--save-dev");
    expect(addArgv("npm", "vite", "", false)).not.toContain("--save-dev");
  });

  it("never leaves pip waiting on a prompt", () => {
    // There is no terminal attached to the exec, so a prompt would hang it
    // until the request times out.
    expect(addArgv("pip", "flask", "", false)).toContain("--no-input");
    expect(removeArgv("pip", "flask")).toContain("--yes");
  });

  it("spells out the Go version rather than relying on the default", () => {
    expect(addArgv("go", "github.com/a/b", "", false)).toEqual([
      "go",
      "get",
      "github.com/a/b@latest",
    ]);
    // Go has no uninstall; @none is how a requirement is dropped.
    expect(removeArgv("go", "github.com/a/b")).toEqual([
      "go",
      "get",
      "github.com/a/b@none",
    ]);
  });
});

describe("editRequirements", () => {
  it("appends a requirement that is not there yet", () => {
    expect(editRequirements("flask\n", "requests", "==2.31.0")).toBe(
      "flask\nrequests==2.31.0\n",
    );
  });

  it("replaces one that is, in place", () => {
    // In place, so the order a hand-written file was arranged in survives.
    expect(editRequirements("flask\nrequests==2.0\nrich\n", "requests", "==2.31.0"))
      .toBe("flask\nrequests==2.31.0\nrich\n");
  });

  it("removes one when no version is given", () => {
    expect(editRequirements("flask\nrequests==2.0\n", "requests", null)).toBe(
      "flask\n",
    );
  });

  it("matches the way pip does, not the way a string compare does", () => {
    // pip treats these as the same distribution.
    expect(editRequirements("Flask_Login==0.6\n", "flask-login", "==0.7")).toBe(
      "flask-login==0.7\n",
    );
  });

  it("leaves comments and flags exactly where they were", () => {
    const raw = "# base deps\n-r shared.txt\nflask\n";

    expect(editRequirements(raw, "rich", "")).toBe(
      "# base deps\n-r shared.txt\nflask\nrich\n",
    );
  });

  it("does not walk down the page on repeated adds", () => {
    const once = editRequirements("flask\n\n\n", "rich", "");

    expect(once).toBe("flask\nrich\n");
    expect(editRequirements(once, "requests", "")).toBe(
      "flask\nrich\nrequests\n",
    );
  });

  it("writes a bare name when no version was asked for", () => {
    expect(editRequirements("", "flask", "")).toBe("flask\n");
  });
});
