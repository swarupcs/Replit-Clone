import { request } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** An always-on deployment, end to end, against real Docker.
 *
 *  Off by default: it needs a Docker daemon, the sandbox images built
 *  (`pnpm images:build`), a throwaway Postgres, and a few minutes to install
 *  dependencies for each template it publishes. Run it with
 *
 *    DEPLOY_E2E=1 TEST_DATABASE_URL=... pnpm --filter @replit-clone/server \
 *      exec vitest run src/service/serviceDeploy.e2e.test.ts
 *
 *  It is kept because it is the only thing here that could have caught either
 *  of the two bugs this feature actually shipped with, both of which were
 *  invisible to every unit test and to the type checker:
 *
 *  1. The readiness probe was a TCP connect, and in host-loopback mode the
 *     port belongs to `docker-proxy`, which accepts a connection whether or
 *     not anything is listening inside. Every publish reported LIVE within a
 *     second and every request to the new address died with a socket hang up.
 *  2. The serve command ran under `sh -lc`, and a login shell replaces PATH
 *     with the distribution's default. Node and Python live in /usr/bin and
 *     survived it; Go does not, so every Go deployment failed with
 *     "go: not found" five minutes later when the readiness wait gave up.
 *
 *  Both are the same kind of failure: something two layers down behaving
 *  differently from how it reads.
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const enabled = process.env["DEPLOY_E2E"] === "1" && Boolean(TEST_DATABASE_URL);

interface Answer {
  status: number;
  body: string;
}

/** A request with an explicit Host, which is the whole routing mechanism on
 *  the public origin. `fetch` forbids setting it. */
function send(
  port: number,
  host: string,
  path: string,
  method = "GET",
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!enabled)("publishing a project that serves from a process", () => {
  let prisma: typeof import("../lib/prisma.js").prisma;
  let deployService: typeof import("./deployService.js");
  let createProjectService: typeof import("./projectService.js").createProjectService;
  // The destructive path is the purge now; delete puts a project in the trash.
  let purgeProject: typeof import("./projectService.js").purgeProject;
  let server: Server;
  let port: number;
  let userId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;

    ({ prisma } = await import("../lib/prisma.js"));
    deployService = await import("./deployService.js");
    ({ createProjectService, purgeProject } = await import(
      "./projectService.js"
    ));

    const { ensureNetwork } = await import("../containers/sandboxNetwork.js");
    await ensureNetwork();

    const { createDeploySiteServer, installServiceUpgrade } = await import(
      "../deploySite.js"
    );
    server = createDeploySiteServer();
    installServiceUpgrade(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const user = await prisma.user.create({
      data: { email: `deploy-e2e-${Date.now().toString()}@example.test`, passwordHash: "x" },
    });
    userId = user.id;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  /** Publishes one template and answers three questions about the result. */
  async function publishAndProbe(templateId: string) {
    const project = await createProjectService(userId, `e2e-${templateId}`, templateId);

    try {
      const deployment = await deployService.publish(project.id);
      const host = new URL(deployService.siteUrl(deployment.subdomain)).hostname;

      return {
        deployment,
        home: await send(port, host, "/"),
        health: await send(port, host, "/api/health"),
        posted: await send(port, host, "/api/health", "POST"),
      };
    } finally {
      await deployService.unpublish(project.id).catch(() => undefined);
      // The service rather than a bare row delete: it removes the working
      // tree and the container too. Deleting the row alone leaves an orphan
      // directory per run, which is exactly what the first draft of this did.
      await purgeProject(project.id).catch(() => undefined);
    }
  }

  // Every template that has no static output. Each uses a different image and
  // a different runtime, which is the point: the PATH bug showed up in exactly
  // one of them.
  const templates = ["node-express", "python-flask", "python-fastapi", "go-http"];

  for (const templateId of templates) {
    it(
      `publishes ${templateId} and serves it at its own address`,
      async () => {
        const { deployment, home, health, posted } = await publishAndProbe(templateId);

        expect(deployment.status).toBe("live");
        expect(deployment.kind).toBe("service");
        expect(deployment.url).not.toBeNull();

        // The app's own page, proxied from its container. A 502 here is the
        // readiness bug; a 404 is the site being served as static files.
        expect(home.status).toBe(200);
        expect(health.status).toBe(200);
        expect(health.body).toContain("ok");

        // Not a 404 from the static path's method check, which used to run
        // before the kind was known and made every service read-only. What
        // comes back is the app's own answer -- 404, 405 or 200 depending on
        // the framework -- and any of them means the request got through.
        expect([200, 404, 405]).toContain(posted.status);
      },
      600_000,
    );
  }
});
