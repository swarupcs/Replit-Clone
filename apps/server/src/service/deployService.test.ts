import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canSymlink } from "../test/capabilities.js";
import {
  copyTree,
  deployTarget,
  generateSubdomain,
  siteDirectory,
  siteUrl,
  subdomainFromHost,
  tailLog,
} from "./deployService.js";
import { SUBDOMAIN_PATTERN } from "@replit-clone/shared";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rc-deploy-"));
}

describe("deployTarget", () => {
  it("offers a build for the templates that produce files", () => {
    const vite = deployTarget("react-vite");
    expect(vite.deployable).toBe(true);
    expect(vite.buildCommand).toContain("npm run build");
    expect(vite.outputDir).toBe("dist");
  });

  it("has nothing to build for a template that is already its own output", () => {
    const html = deployTarget("static-html");
    expect(html.deployable).toBe(true);
    expect(html.buildCommand).toBe("");
    expect(html.outputDir).toBe(".");
  });

  it("refuses a template that needs a process at request time", () => {
    // Express, Flask, FastAPI and Go all serve responses from running code.
    // There is nothing static to publish, and saying so is better than
    // offering a button that always fails.
    for (const id of ["node-express", "python-flask", "python-fastapi", "go-http"]) {
      const target = deployTarget(id);
      expect(target.deployable).toBe(false);
      expect(target.reason).toBeTruthy();
    }
  });
});

describe("subdomainFromHost", () => {
  // The suite's DEPLOY_ORIGIN defaults to localhost.
  it("reads the label in front of the configured host", () => {
    expect(subdomainFromHost("quiet-fern-84f1.localhost")).toBe("quiet-fern-84f1");
    expect(subdomainFromHost("quiet-fern-84f1.localhost:3102")).toBe(
      "quiet-fern-84f1",
    );
  });

  it("is case-insensitive, because a Host header need not be lowercase", () => {
    expect(subdomainFromHost("Quiet-Fern.LOCALHOST")).toBe("quiet-fern");
  });

  it("refuses the bare host, which is not a site", () => {
    expect(subdomainFromHost("localhost")).toBeUndefined();
    expect(subdomainFromHost("localhost:3102")).toBeUndefined();
  });

  it("refuses a host that merely ends with the same letters", () => {
    // "notlocalhost" ends with "localhost" as a STRING; the suffix compared is
    // ".localhost", which is what makes this a different host rather than a
    // subdomain of ours.
    expect(subdomainFromHost("notlocalhost")).toBeUndefined();
    expect(subdomainFromHost("evil.com")).toBeUndefined();
  });

  it("refuses more than one label", () => {
    // Allowing it would make an address ambiguous: a.b.localhost could be
    // read as either site.
    expect(subdomainFromHost("a.b.localhost")).toBeUndefined();
  });

  it("refuses a label that could not be a directory name", () => {
    expect(subdomainFromHost("...localhost")).toBeUndefined();
    expect(subdomainFromHost("-lead.localhost")).toBeUndefined();
    expect(subdomainFromHost(`${"a".repeat(64)}.localhost`)).toBeUndefined();
  });

  it("refuses an IPv6 literal outright", () => {
    expect(subdomainFromHost("[::1]:3102")).toBeUndefined();
  });
});

describe("generateSubdomain", () => {
  it("always produces something that can be both a hostname and a directory", () => {
    for (let i = 0; i < 200; i += 1) {
      const name = generateSubdomain();
      expect(SUBDOMAIN_PATTERN.test(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  it("does not repeat itself in any run anybody would notice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateSubdomain());
    // 24 x 24 x 65536 possibilities; a handful of collisions in 500 draws
    // would still be normal, hundreds would mean the randomness is broken.
    expect(seen.size).toBeGreaterThan(450);
  });
});

describe("siteUrl", () => {
  it("prefixes the host rather than the whole origin", () => {
    // Concatenating onto the origin string would give
    // "http://localhost:3102/sub", which is a path, not a site.
    expect(siteUrl("quiet-fern")).toMatch(/^http:\/\/quiet-fern\.localhost/);
  });
});

describe("siteDirectory", () => {
  it("refuses anything that is not a DNS label", () => {
    // This value arrives from a Host header, and it becomes a path segment.
    for (const bad of ["..", "../etc", "a/b", "", "UPPER", "-x"]) {
      expect(() => siteDirectory(bad)).toThrow();
    }
  });

  it("puts a real one under the deployments root", () => {
    expect(siteDirectory("quiet-fern-84f1")).toContain("quiet-fern-84f1");
  });
});

describe("tailLog", () => {
  it("joins both streams and keeps the end, where a failure is", () => {
    expect(tailLog("out", "err")).toBe("out\nerr");
  });

  it("keeps a bounded tail of a very long build", () => {
    const log = tailLog("x".repeat(50_000), "");
    expect(log.length).toBeLessThan(9_000);
    expect(log.startsWith("…")).toBe(true);
  });
});

describe("copyTree", () => {
  it("copies a build output as it stands", async () => {
    const from = await scratch();
    const to = path.join(await scratch(), "site");

    await writeFile(path.join(from, "index.html"), "<h1>hi</h1>");
    await mkdir(path.join(from, "assets"));
    await writeFile(path.join(from, "assets", "app.js"), "console.log(1)");

    const result = await copyTree(from, to, 1024 * 1024);

    expect(result.files).toBe(2);
    expect(await readFile(path.join(to, "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(await readFile(path.join(to, "assets", "app.js"), "utf8")).toBe(
      "console.log(1)",
    );
  });

  // Windows grants symlink creation only to administrators or with Developer
  // Mode on, so there is nothing to assert where one cannot be made.
  it.skipIf(!canSymlink)(
    "never publishes a symlink, or what one points at",
    async () => {
      // The whole reason this is hand-written rather than fs.cp. A build output
      // is produced by untrusted code, and this tree is served to the public
      // with no authentication at all.
      const from = await scratch();
      const outside = await scratch();
      const to = path.join(await scratch(), "site");

      await writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
      await writeFile(path.join(from, "index.html"), "<h1>hi</h1>");
      await symlink(path.join(outside, "secret.txt"), path.join(from, "leak.txt"));

      const result = await copyTree(from, to, 1024 * 1024);

      expect(await readdir(to)).toEqual(["index.html"]);
      expect(result.files).toBe(1);
    },
  );

  it.skipIf(!canSymlink)(
    "does not descend a symlinked directory either",
    async () => {
      // Following one is the same disclosure with an extra hop: the link is a
      // directory rather than a file, and everything under it would be copied.
      const from = await scratch();
      const outside = await scratch();
      const to = path.join(await scratch(), "site");

      await mkdir(path.join(outside, "private"));
      await writeFile(path.join(outside, "private", "key.pem"), "SECRET");
      await writeFile(path.join(from, "index.html"), "<h1>hi</h1>");
      await symlink(path.join(outside, "private"), path.join(from, "assets"), "dir");

      const result = await copyTree(from, to, 1024 * 1024);

      expect(await readdir(to)).toEqual(["index.html"]);
      expect(result.files).toBe(1);
    },
  );

  it("stops at the byte budget instead of reporting on it afterwards", async () => {
    const from = await scratch();
    const to = path.join(await scratch(), "site");

    await writeFile(path.join(from, "big.bin"), Buffer.alloc(4096));

    await expect(copyTree(from, to, 1024)).rejects.toThrow(/larger than/i);
  });

  it("counts every file towards the budget, not each one on its own", async () => {
    const from = await scratch();
    const to = path.join(await scratch(), "site");

    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(from, `f${String(i)}.bin`), Buffer.alloc(400));
    }

    await expect(copyTree(from, to, 1000)).rejects.toThrow(/larger than/i);
  });
});
