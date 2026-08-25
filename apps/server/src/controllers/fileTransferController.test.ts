import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectService = vi.hoisted(() => ({ assertProjectAccess: vi.fn() }));
const diskUsageService = vi.hoisted(() => ({
  assertWithinQuota: vi.fn(),
  recordWrite: vi.fn(),
}));
const claimOneForSandbox = vi.hoisted(() => vi.fn());

vi.mock("../service/projectService.js", () => projectService);
vi.mock("../service/diskUsageService.js", () => diskUsageService);
// The upload path checks the OWNER's overall budget too, and the real one
// reaches Postgres. Unmocked it was answering out of its own fail-open
// timeout, which made every case in this file wait on a database that is not
// running to decide something this suite is not testing.
vi.mock("../service/userQuotaService.js", () => ({
  assertUserDiskQuota: vi.fn(() => Promise.resolve(undefined)),
}));
// Only the chown is stubbed: path resolution is the security boundary this
// suite exists to exercise, so it stays real.
vi.mock("../utils/projectPaths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/projectPaths.js")>()),
  claimOneForSandbox,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  downloadFileController,
  MAX_UPLOAD_BYTES,
  uploadFilesController,
} from "./fileTransferController.js";
import { apiApp, bearer, TEST_PROJECT, TEST_USER } from "../test/apiHarness.js";
import { projectRoot } from "../utils/projectPaths.js";
import { ForbiddenError } from "../utils/errors.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 },
});

const app = apiApp([
  {
    method: "post",
    path: "/p/:projectId/files",
    handler: uploadFilesController,
    before: [upload.array("files", 20)],
  },
  { method: "get", path: "/p/:projectId/files", handler: downloadFileController },
]);

const ROOT = projectRoot(TEST_PROJECT);
const auth = () => ({ Authorization: bearer() });

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  projectService.assertProjectAccess.mockResolvedValue({ id: TEST_PROJECT });
  diskUsageService.assertWithinQuota.mockResolvedValue(undefined);
  // The controller calls `.catch()` on the result, so this has to be a promise.
  claimOneForSandbox.mockResolvedValue(undefined);

  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});

describe("uploadFilesController", () => {
  it("writes an uploaded file into the project and reports its path", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("hello"), "notes.txt");

    expect(response.status).toBe(201);
    expect(response.body.data.paths).toEqual(["notes.txt"]);
    expect(await fs.readFile(path.join(ROOT, "notes.txt"), "utf8")).toBe("hello");
  });

  it("writes into a nested destination, creating it if needed", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .field("destDir", "assets/img")
      .attach("files", Buffer.from("png"), "logo.png");

    expect(response.status).toBe(201);
    expect(response.body.data.paths).toEqual(["assets/img/logo.png"]);
    expect(await fs.readFile(path.join(ROOT, "assets", "img", "logo.png"), "utf8")).toBe(
      "png",
    );
  });

  it("accepts several files at once and counts them in the message", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("a"), "a.txt")
      .attach("files", Buffer.from("b"), "b.txt");

    expect(response.status).toBe(201);
    expect(response.body.data.paths).toEqual(["a.txt", "b.txt"]);
    expect(response.body.message).toBe("Uploaded 2 files");
  });

  it("says 'file' rather than 'files' for a single upload", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("a"), "a.txt");

    expect(response.body.message).toBe("Uploaded 1 file");
  });

  /** The filename comes from the client, so it is reduced to a basename before
   *  it is ever joined to a path. */
  it.each([
    ["a traversing name", "../../escape.txt", "escape.txt"],
    ["a windows traversal", "..\\..\\escape.txt", "escape.txt"],
    ["an absolute name", "/etc/passwd", "passwd"],
    ["a nested name", "a/b/c.txt", "c.txt"],
  ])("flattens %s to its basename", async (_label, given, expected) => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), given);

    expect(response.status).toBe(201);
    expect(response.body.data.paths).toEqual([expected]);
    // And it really landed inside the project, not beside it.
    expect(await fs.readFile(path.join(ROOT, expected), "utf8")).toBe("x");
  });

  it.each([[".."], ["."]])("refuses a file named %s", async (name) => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), name);

    expect(response.status).toBe(400);
  });

  it("refuses a destination that climbs out of the project", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .field("destDir", "../../..")
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects a request with no files at all", async () => {
    const response = await request(app).post(`/p/${TEST_PROJECT}/files`).set(auth());

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no files/i);
  });

  /** An upload is an editor write arriving by a different route, so it answers
   *  to the same access level and the same quota. */
  it("requires editor access", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(projectService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("writes nothing when the access check refuses", async () => {
    projectService.assertProjectAccess.mockRejectedValue(new ForbiddenError());

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(403);
    await expect(fs.stat(path.join(ROOT, "a.txt"))).rejects.toThrow();
  });

  it("writes nothing when the quota check refuses", async () => {
    diskUsageService.assertWithinQuota.mockRejectedValue(
      new ForbiddenError("Project is out of space", "QUOTA_EXCEEDED"),
    );

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(403);
    await expect(fs.stat(path.join(ROOT, "a.txt"))).rejects.toThrow();
  });

  it("charges the quota only for the growth when overwriting", async () => {
    await fs.writeFile(path.join(ROOT, "a.txt"), "old contents");
    const existingSize = (await fs.stat(path.join(ROOT, "a.txt"))).size;

    await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("new"), "a.txt");

    expect(diskUsageService.assertWithinQuota).toHaveBeenCalledWith(
      TEST_PROJECT,
      3,
      existingSize,
    );
    expect(diskUsageService.recordWrite).toHaveBeenCalledWith(
      TEST_PROJECT,
      3,
      existingSize,
    );
  });

  it("treats a brand-new file as replacing nothing", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("abc"), "fresh.txt");

    expect(diskUsageService.assertWithinQuota).toHaveBeenCalledWith(TEST_PROJECT, 3, 0);
  });

  /** New files must belong to the container's user like everything else in the
   *  tree, or the project cannot modify what it was just given.
   *
   *  The uploaded FILE, not its directory: claiming the destination walked
   *  every path beneath it, so an upload to the project root re-chowned
   *  node_modules on every single upload. */
  it("hands the new file itself to the sandbox user", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(claimOneForSandbox).toHaveBeenCalledWith(path.join(ROOT, "a.txt"));
    expect(claimOneForSandbox).not.toHaveBeenCalledWith(ROOT);
  });

  it("still succeeds when the chown fails, since the write did not", async () => {
    claimOneForSandbox.mockRejectedValue(new Error("EPERM"));

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(201);
  });

  it("refuses an unauthenticated upload", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/files`)
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(401);
  });

  it("rejects an invalid project id", async () => {
    const response = await request(app)
      .post("/p/nonsense/files")
      .set(auth())
      .attach("files", Buffer.from("x"), "a.txt");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_PROJECT_ID");
  });
});

describe("downloadFileController", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(ROOT, "src"), { recursive: true });
    await fs.writeFile(path.join(ROOT, "src", "app.js"), "console.log(1)");
  });

  it("streams the file back as an attachment", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/app.js" })
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="app.js"',
    );
    // octet-stream, so superagent hands back a Buffer rather than parsed text.
    expect((response.body as Buffer).toString("utf8")).toBe("console.log(1)");
  });

  /** The name reaches a response header, so quotes, backslashes, and control
   *  characters (CR/LF above all) must not survive into it. */
  it("strips header-hostile characters from the download filename", async () => {
    // CR/LF cannot appear in a Windows filename, so the DEL control character
    // stands in: stripped by the same rule, legal to create on every platform.
    const onDisk = "badname.js";
    await fs.writeFile(path.join(ROOT, onDisk), "x");

    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: onDisk })
      .set(auth());

    expect(response.status).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toBe(
      'attachment; filename="badname.js"; filename*=UTF-8\'\'bad%7Fname.js',
    );
  });

  /** Served from the API's origin, so rendering it inline is exactly the
   *  problem the preview sandbox exists to avoid. */
  it("marks the response so a browser will not render it", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/app.js" })
      .set(auth());

    expect(response.headers["content-type"]).toMatch(/application\/octet-stream/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("only needs viewer access", async () => {
    await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/app.js" })
      .set(auth());

    expect(projectService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "viewer",
    );
  });

  it.each([
    ["a traversal", "../../../../etc/passwd"],
    ["a windows traversal", "..\\..\\..\\windows\\win.ini"],
  ])("refuses to serve %s", async (_label, badPath) => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: badPath })
      .set(auth());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects a path containing a null byte", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/app.js\0../../etc/passwd" })
      .set(auth());

    expect(response.status).toBe(400);
  });

  it.each([
    ["no path", {}],
    ["an empty path", { path: "" }],
  ])("rejects a request with %s", async (_label, query) => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query(query)
      .set(auth());

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/path is required/i);
  });

  it("rejects a directory", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src" })
      .set(auth());

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/not a file/i);
  });

  it("rejects a file that does not exist", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/missing.js" })
      .set(auth());

    expect(response.status).toBe(400);
  });

  it("refuses an unauthenticated download", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/files`)
      .query({ path: "src/app.js" });

    expect(response.status).toBe(401);
  });
});
