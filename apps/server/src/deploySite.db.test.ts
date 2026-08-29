import { request } from "node:http";
import type { Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "./test/dbScope.js";

/** The public origin, end to end.
 *
 *  This is the one listener in the product that answers somebody with no
 *  account, so it is exercised as a real HTTP server against real rows and real
 *  files rather than through its parts. A stub cannot answer the questions that
 *  matter here — whether a Host header actually routes, whether a traversal
 *  actually escapes, whether an unpublished site is actually unreachable.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A request with an explicit Host, which is the whole routing mechanism here.
 *
 *  `fetch` forbids setting Host, so this goes through node:http directly. */
function get(port: number, host: string, urlPath: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { host, accept: "text/html" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The same, for a method other than GET. */
function send(
  port: number,
  host: string,
  urlPath: string,
  method: string,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: { host, accept: "text/html" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!TEST_DATABASE_URL)("the public deployment origin", () => {
  const scope = dbScope("deploy-site");

  let prisma: typeof import("./lib/prisma.js").prisma;
  let deployService: typeof import("./service/deployService.js");
  let server: Server;
  let port: number;
  let root: string;

  let userId: string;
  let projectId: string;
  const subdomain = "quiet-fern-84f1";

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("./lib/prisma.js"));
    deployService = await import("./service/deployService.js");

    const { createDeploySiteServer } = await import("./deploySite.js");
    server = createDeploySiteServer();

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { name: "site", template: "react-vite", ownerId: userId },
    });
    projectId = project.id;

    root = deployService.siteDirectory(subdomain);
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>published</h1>");
    await writeFile(path.join(root, "assets", "app.js"), "console.log(1)");
    await writeFile(path.join(root, ".env"), "SECRET=hunter2");

    // A file OUTSIDE the site, which a traversal would be reaching for.
    await writeFile(
      path.join(root, "..", "not-yours.txt"),
      "another project's site",
    );
  });

  afterEach(async () => {
    await prisma.deployment.deleteMany({ where: { projectId } }).catch(() => undefined);
    await scope.cleanup(prisma);
    await rm(root, { recursive: true, force: true });
    await rm(path.join(root, "..", "not-yours.txt"), { force: true });
  });

  /** Publishes the fixture, so the row says it is live. */
  async function goLive() {
    await prisma.deployment.create({
      data: {
        projectId,
        subdomain,
        status: "LIVE",
        buildCommand: "npm install && npm run build",
        outputDir: "dist",
        deployedAt: new Date(),
      },
    });
  }

  it("serves the site's index at its own address", async () => {
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/");

    expect(answer.status).toBe(200);
    expect(answer.body).toContain("published");
  });

  it("serves an asset with a usable content type", async () => {
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/assets/app.js");

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("text/javascript");
    // Nothing here should ever be sniffed into something executable it is not.
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("falls back to the index for a client-side route", async () => {
    // An app that owns /about has no about.html; the router in index.html is
    // what knows the route exists.
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/about");

    expect(answer.status).toBe(200);
    expect(answer.body).toContain("published");
  });

  it("does not fall back for a missing asset", async () => {
    // A broken script silently answering with HTML fails much later and much
    // less legibly than a 404.
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/assets/gone.js");

    expect(answer.status).toBe(404);
  });

  it("will not serve a dotfile that made it into the output", async () => {
    // Vite copies public/ verbatim, so a stray public/.env would otherwise be
    // handed to anybody who guessed the name.
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/.env");

    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("hunter2");
  });

  it("will not let a path escape the site it belongs to", async () => {
    await goLive();

    for (const attempt of [
      "/../not-yours.txt",
      "/assets/../../not-yours.txt",
      "/%2e%2e%2fnot-yours.txt",
    ]) {
      const answer = await get(port, `${subdomain}.localhost`, attempt);
      expect(answer.body).not.toContain("another project's site");
    }
  });

  it("answers nothing at all for a site that was never published", async () => {
    // No row at all: the deployment fixture is deliberately not created.
    const answer = await get(port, `${subdomain}.localhost`, "/");

    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("published");
  });

  it("answers nothing for a row whose first build has not gone live", async () => {
    // The row exists so the subdomain is reserved, but deployedAt is null.
    // Serving the files at this point would publish a half-built site.
    await prisma.deployment.create({
      data: {
        projectId,
        subdomain,
        status: "BUILDING",
        buildCommand: "npm install && npm run build",
        outputDir: "dist",
      },
    });

    const answer = await get(port, `${subdomain}.localhost`, "/");

    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("published");
  });

  it("serves nothing on the bare host, which is not a site", async () => {
    await goLive();

    const answer = await get(port, "localhost", "/");

    expect(answer.status).toBe(404);
  });

  it("sets no cookie and asks for none", async () => {
    // There is no identity on this origin. A Set-Cookie here would mean one had
    // crept in.
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/");

    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("does not let a browser cache the HTML across a redeploy", async () => {
    // The index keeps its name across every deploy, so caching it is exactly
    // how a redeploy fails to appear.
    await goLive();

    const answer = await get(port, `${subdomain}.localhost`, "/");

    expect(answer.headers["cache-control"]).toBe("no-cache");
  });

  it("refuses a POST to a static site", async () => {
    // A directory of files has no answer for one, and pretending otherwise
    // would be a 200 with the index in it.
    await goLive();

    const answer = await send(port, `${subdomain}.localhost`, "/", "POST");

    expect(answer.status).toBe(404);
  });

  describe("a service deployment", () => {
    /** Live, of the SERVICE kind, with no container behind it. */
    async function goLiveAsService() {
      await prisma.deployment.create({
        data: {
          projectId,
          subdomain,
          status: "LIVE",
          kind: "SERVICE",
          port: 3000,
          buildCommand: "npm install --omit=dev && node server.js",
          outputDir: "",
          deployedAt: new Date(),
        },
      });
    }

    it("answers 503 rather than 404 when nothing is running", async () => {
      // The distinction is the useful one and is safe to make: the subdomain
      // already resolved, so nothing is disclosed by saying the app is down
      // rather than absent. A 404 here would send its author looking for a
      // deployment that exists.
      await goLiveAsService();

      const answer = await get(port, `${subdomain}.localhost`, "/");

      expect(answer.status).toBe(503);
      expect(answer.body).toContain("not responding");
    });

    it("never serves the source tree it has copied out", async () => {
      // The published directory for a service is SOURCE, not a build output:
      // server code, and whatever else was in the project. Falling back to
      // the static path for it would publish the lot.
      await goLiveAsService();

      const answer = await get(port, `${subdomain}.localhost`, "/index.html");

      expect(answer.status).toBe(503);
      // The fixture's own index, which the static path WOULD have served.
      expect(answer.body).not.toContain("<h1>published</h1>");
    });

    it("does not disclose the .env sitting in that tree", async () => {
      await goLiveAsService();

      const answer = await get(port, `${subdomain}.localhost`, "/.env");

      expect(answer.body).not.toContain("hunter2");
    });

    it("takes a POST, because a published API exists to be posted to", async () => {
      // Not a 404. The static path refuses every method but GET and HEAD, and
      // applying that before knowing the kind made every service read-only.
      await goLiveAsService();

      const answer = await send(port, `${subdomain}.localhost`, "/api", "POST");

      // 503 because nothing is running -- but it reached the proxy branch,
      // which is what a 404 would have proved it did not.
      expect(answer.status).toBe(503);
    });

    it("is unreachable once it is no longer live", async () => {
      await prisma.deployment.create({
        data: {
          projectId,
          subdomain,
          status: "BUILDING",
          kind: "SERVICE",
          port: 3000,
          buildCommand: "x",
          outputDir: "",
        },
      });

      const answer = await get(port, `${subdomain}.localhost`, "/");

      expect(answer.status).toBe(404);
    });
  });
});
