import request from "supertest";
import { describe, expect, it, vi } from "vitest";

/** The real configuration, with `ADMIN_EMAILS` writable per case.
 *
 *  Both halves of that matter. The module's other exports have to survive --
 *  `isProduction` is read by the logger at import time, so a wholesale stub
 *  takes the logger down with it and the suite fails before collecting a
 *  case. And `env`'s other FIELDS have to survive too: `bearer()` signs a real
 *  token, which needs the real `JWT_ACCESS_SECRET`.
 */
const settings = vi.hoisted(() => ({ ADMIN_EMAILS: "" }));

vi.mock("../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/env.js")>();
  Object.assign(settings, actual.env, { ADMIN_EMAILS: "" });
  return { ...actual, env: settings };
});

import { adminEmails, isAdminEmail, requireAdmin } from "./requireAdmin.js";
import { apiApp, bearer, TEST_USER } from "../test/apiHarness.js";

/** Who may act on reports.
 *
 *  An `ADMIN_EMAILS` allowlist rather than a role on `User`: this app is
 *  deployed as one operator running their own instance, and a role column
 *  needs a way to make the first admin, which is its own bootstrapping
 *  problem solved by an env var anyway.
 *
 *  It is the only thing standing between a signed-in stranger and the power to
 *  un-publish other people's projects, so it is tested as a boundary rather
 *  than as a helper.
 */
describe("parsing the allowlist", () => {
  it("reads a single address", () => {
    expect([...adminEmails("ops@example.com")]).toEqual(["ops@example.com"]);
  });

  /** This value is typed into a `.env` or a compose file by hand. A parser
   *  that split on "," and stopped would grant access to the first address and
   *  silently not to the second. */
  it("tolerates the spacing a human types", () => {
    expect([...adminEmails(" ops@example.com , second@example.com ")]).toEqual([
      "ops@example.com",
      "second@example.com",
    ]);
  });

  it("ignores empty entries", () => {
    expect([...adminEmails("ops@example.com,,")]).toEqual(["ops@example.com"]);
    expect([...adminEmails(",")]).toEqual([]);
  });

  it("is case-insensitive on both sides", () => {
    expect(isAdminEmail("OPS@Example.com", "ops@example.com")).toBe(true);
    expect(isAdminEmail("ops@example.com", "OPS@EXAMPLE.COM")).toBe(true);
  });

  /** The failure this exists to make impossible.
   *
   *  An empty allowlist means NOBODY. A deployment that has not thought about
   *  moderation gets a queue no one can open, which is inert. The other way
   *  round -- empty meaning everybody -- would hand the power to un-publish
   *  any project to every account that ever signed up, on a default.
   */
  it("grants nobody when the allowlist is empty", () => {
    expect(isAdminEmail("anyone@example.com", "")).toBe(false);
    expect(isAdminEmail("anyone@example.com", "   ")).toBe(false);
    expect(isAdminEmail("", "")).toBe(false);
  });

  it("does not match an address that merely contains one", () => {
    expect(isAdminEmail("ops@example.com.attacker.test", "ops@example.com")).toBe(
      false,
    );
    expect(isAdminEmail("notops@example.com", "ops@example.com")).toBe(false);
  });
});

describe("the gate on a request", () => {
  function app() {
    return apiApp([
      {
        method: "get",
        path: "/admin/reports",
        before: [requireAdmin],
        handler: (_req, res) => {
          res.json({ success: true, data: { reports: [] } });
        },
      },
    ]);
  }

  it("lets an operator through", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app())
      .get("/admin/reports")
      .set("Authorization", bearer());

    expect(response.status).toBe(200);
  });

  it("refuses a signed-in stranger", async () => {
    settings["ADMIN_EMAILS"] = "somebody-else@example.com";

    const response = await request(app())
      .get("/admin/reports")
      .set("Authorization", bearer());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("NOT_ADMIN");
  });

  it("refuses everybody when nothing is configured", async () => {
    settings["ADMIN_EMAILS"] = "";

    const response = await request(app())
      .get("/admin/reports")
      .set("Authorization", bearer());

    expect(response.status).toBe(403);
  });

  /** The gate runs after requireAuth and reads its context. A caller with no
   *  token must be told they need one, not that they are not an operator --
   *  and must certainly not be let through. */
  it("refuses a caller with no token at all", async () => {
    settings["ADMIN_EMAILS"] = TEST_USER.email;

    const response = await request(app()).get("/admin/reports");

    expect(response.status).toBe(401);
  });
});
