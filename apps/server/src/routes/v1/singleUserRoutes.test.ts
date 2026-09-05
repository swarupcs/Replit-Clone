import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The routes that create or recover an account are NOT MOUNTED.
 *
 *  This is the file that makes the claim testable, and the claim is a specific
 *  one: 404, not 403. A 403 would mean the handler ran and refused, which is
 *  the arrangement §6 decision 17 argues against — a rule enforced inside each
 *  controller is one the next route somebody adds does not know to ask about.
 *  A 404 means there is nothing there to forget.
 *
 *  Asserted in both directions, because half of this feature is that the
 *  ordinary deployment is untouched.
 */

vi.mock("../../controllers/authController.js", () => ({
  login: vi.fn((_req: unknown, res: { json: (b: unknown) => void }) => {
    res.json({ ok: "login" });
    return Promise.resolve();
  }),
  // The second half of a sign-in (plan.md §11.6). Mounted in every mode, so
  // it has to exist in the mock or the router fails to build.
  loginTotp: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  refresh: vi.fn(),
  requestEmailVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  signup: vi.fn(),
  verifyEmail: vi.fn(),
}));

/** Two-factor management, mounted in EVERY mode including single-user -- see
 *  the router. Stubbed only so the module loads; what these routes do is
 *  covered in `twoFactorManage.test.ts`. */
vi.mock("../../controllers/twoFactorController.js", () => ({
  beginTwoFactorController: vi.fn(),
  confirmTwoFactorController: vi.fn(),
  disableTwoFactorController: vi.fn(),
  regenerateRecoveryCodesController: vi.fn(),
  twoFactorStatusController: vi.fn(),
}));

vi.mock("../../middlewares/requireAuth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => { next(); },
}));

const isGithubConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../service/oauthService.js", () => ({
  isGithubConfigured,
  githubAuthorizeUrl: vi.fn(() => "https://github.test/authorize"),
  signInWithGithub: vi.fn(),
}));

/** The mode is read at module load in two places -- the router and the
 *  providers controller -- so each configuration needs a fresh import graph. */
async function appWith(email: string) {
  vi.resetModules();
  process.env["SINGLE_USER_EMAIL"] = email;

  const router = (await import("./auth.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/auth", router);
  return app;
}

/** Everything whose existence the mode changes. */
const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

const ACCOUNT_ROUTES = [
  { method: "post" as const, path: "/auth/signup" },
  { method: "post" as const, path: "/auth/password-reset" },
  { method: "post" as const, path: "/auth/password-reset/confirm" },
  { method: "post" as const, path: "/auth/verify-email" },
  { method: "post" as const, path: "/auth/verify-email/request" },
  { method: "get" as const, path: "/auth/github" },
  { method: "get" as const, path: "/auth/github/callback" },
];

beforeEach(() => {
  vi.clearAllMocks();
  isGithubConfigured.mockReturnValue(true);
});

describe("an ordinary deployment", () => {
  it("mounts every account route", async () => {
    const app = await appWith("");

    for (const route of ACCOUNT_ROUTES) {
      const response = await request(app)[route.method](route.path);
      expect(response.status, `${route.method} ${route.path}`).not.toBe(404);
    }
  });

  it("offers GitHub when it is configured", async () => {
    const app = await appWith("");

    const response = await request(app).get("/auth/providers");

    expect(response.body.data).toMatchObject({
      github: true,
      singleUser: false,
    });
  });
});

describe("single-user mode", () => {
  it("does not mount any of them", async () => {
    const app = await appWith("me@example.com");

    for (const route of ACCOUNT_ROUTES) {
      const response = await request(app)[route.method](route.path);
      // 404, not 403: there is no handler, so there is no check to forget.
      expect(response.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it("still mounts sign-in", async () => {
    const app = await appWith("me@example.com");

    // Every route in this product authenticates through a session. A server
    // that issued one to anybody who asked would be an unauthenticated server
    // on whatever network it can be reached from, which is not what
    // "personal" means.
    const response = await request(app).post("/auth/login").send({});

    expect(response.status).not.toBe(404);
  });

  it("withholds GitHub even when it is configured", async () => {
    const app = await appWith("me@example.com");

    // Signing in with GitHub CREATES an account, and this deployment has the
    // one it is going to have.
    const response = await request(app).get("/auth/providers");

    expect(response.body.data).toMatchObject({
      github: false,
      singleUser: true,
    });
  });

  it("says which mode it is in, so the form knows what to draw", async () => {
    const app = await appWith("me@example.com");

    const response = await request(app).get("/auth/providers");

    // Three links on the sign-in form point at routes that are now 404s. The
    // app hides them on this flag, and a link to a 404 is a worse answer than
    // no link.
    expect(response.body.data.singleUser).toBe(true);
  });
});

/** §10.5's half: the surface that needs a second person.
 *
 *  Mounted through the real project router, so this asserts against the wiring
 *  rather than against a list of paths somebody kept in step by hand.
 */
describe("the surface that needs a second person", () => {
  /** Everything whose existence single-user mode changes on the project
   *  router. Each is dead by arithmetic there, not by preference. */
  const SHARED_ROUTES = [
    // Redeeming a share link means signing in and becoming a collaborator, and
    // the one account that can sign in already owns the project.
    { method: "get" as const, path: "/projects/share/preview" },
    { method: "post" as const, path: "/projects/share/redeem" },
    { method: "get" as const, path: `/projects/${PROJECT}/sharing` },
    { method: "post" as const, path: `/projects/${PROJECT}/share-link` },
    // A report needs a reporter and a separate operator (§6 decision 11).
    { method: "post" as const, path: `/projects/${PROJECT}/report` },
    { method: "get" as const, path: `/projects/${PROJECT}/moderation` },
    { method: "post" as const, path: `/projects/${PROJECT}/appeal` },
    // The gallery lists what OTHER people published.
    { method: "get" as const, path: "/projects/public" },
  ];

  async function projectsAppWith(email: string) {
    vi.resetModules();
    process.env["SINGLE_USER_EMAIL"] = email;

    const router = (await import("./projects.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/projects", router);
    return app;
  }

  it("is mounted on an ordinary deployment", async () => {
    const app = await projectsAppWith("");

    for (const route of SHARED_ROUTES) {
      const response = await request(app)[route.method](route.path);
      // 401 from requireAuth is the expected answer here, and it is proof the
      // route exists -- which is the only thing being asserted.
      expect(response.status, `${route.method} ${route.path}`).not.toBe(404);
    }
  });

  it("is not mounted when there is one account", async () => {
    const app = await projectsAppWith("me@example.com");

    for (const route of SHARED_ROUTES) {
      const response = await request(app)[route.method](route.path);
      expect(response.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it("leaves everything single-player alone", async () => {
    const app = await projectsAppWith("me@example.com");

    // The failure this guards against is an exemption written by theme rather
    // than by reasoning -- sweeping out embeds and exports because they are
    // near sharing in the file. Each of these has a real user at n=1.
    const KEPT = [
      { method: "get" as const, path: "/projects/templates" },
      { method: "get" as const, path: "/projects/trash" },
      { method: "get" as const, path: `/projects/${PROJECT}/tree` },
      { method: "get" as const, path: `/projects/${PROJECT}/export` },
      { method: "get" as const, path: `/projects/${PROJECT}/embed` },
      { method: "get" as const, path: "/projects/local" },
    ];

    for (const route of KEPT) {
      const response = await request(app)[route.method](route.path);
      expect(response.status, `${route.method} ${route.path}`).not.toBe(404);
    }
  });
});
