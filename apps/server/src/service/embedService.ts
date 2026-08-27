import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  EMBED_TOKEN_PATTERN,
  isSecretPath,
  MAX_EMBED_FILE_BYTES,
  type EmbedFile,
  type EmbedFileContents,
  type EmbedPayload,
  type EmbedPreview,
  type EmbedSettings,
  type EmbedState,
  type EmbedView,
  type TreeNodeData,
} from "@replit-clone/shared";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { increment } from "../lib/metrics.js";
import { buildFileTree } from "./fileTreeService.js";
import { siteUrl } from "./deployService.js";
import { assertValidProjectId, resolveInProject } from "../utils/projectPaths.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";

/** Serving a project to somebody who has no account and never will.
 *
 *  This is the only module in the codebase that answers a request with a
 *  project's SOURCE and no session behind it. Three rules follow from that, and
 *  every function here is shaped by one of them:
 *
 *  1. The token is the only credential, so it is checked for shape before it
 *     reaches a query and compared as a whole — never used to build a filter.
 *  2. What is listed and what is served must be the SAME set. A path hidden
 *     from the listing but readable by asking for it directly is not hidden.
 *  3. Nothing here starts, touches or costs a container. An embed is a page
 *     view by a stranger; it must be as cheap as reading a file, because that
 *     is all anyone should be able to make it do.
 */

/* ---- settings ---- */

const VIEWS = new Set<EmbedView>(["code", "preview", "split"]);
const PREVIEWS = new Set<EmbedPreview>(["none", "deployment"]);

export function isEmbedView(value: unknown): value is EmbedView {
  return typeof value === "string" && VIEWS.has(value as EmbedView);
}

export function isEmbedPreview(value: unknown): value is EmbedPreview {
  return typeof value === "string" && PREVIEWS.has(value as EmbedPreview);
}

const DEFAULT_SETTINGS: EmbedSettings = {
  view: "split",
  preview: "deployment",
  activeFile: null,
};

interface EmbedRow {
  token: string;
  view: string;
  preview: string;
  activeFile: string | null;
}

/** Reads a stored row back into settings, tolerating values this version does
 *  not know.
 *
 *  The columns are plain strings rather than enums, because adding an embed
 *  view should not be a migration. The cost is that a row written by a newer
 *  build can be read by an older one, and the answer to that is to fall back
 *  rather than to fail: an embed rendering in its default shape is a far better
 *  outcome than an embed that 500s inside somebody's blog post.
 */
function toSettings(row: EmbedRow): EmbedSettings {
  return {
    view: isEmbedView(row.view) ? row.view : DEFAULT_SETTINGS.view,
    preview: isEmbedPreview(row.preview) ? row.preview : DEFAULT_SETTINGS.preview,
    activeFile: row.activeFile,
  };
}

/* ---- the owner's side ---- */

/** Mints a token, or replaces the one already there.
 *
 *  Replacing rather than adding, for the reason `rotateShareToken` replaces:
 *  "give me a new link" is what somebody reaches for when the old one has gone
 *  somewhere it should not have, and a version of it that leaves the old one
 *  working does not do the job it was reached for.
 */
export async function createEmbed(
  rawProjectId: string,
  settings: Partial<EmbedSettings> = {},
): Promise<EmbedState> {
  const projectId = assertValidProjectId(rawProjectId);

  // 32 bytes. This is a bearer credential that will sit in the HTML of a public
  // page, so it has to be unguessable rather than merely unique — the address
  // being public does not make the OTHER projects' addresses public.
  const token = randomBytes(32).toString("base64url");

  const merged = { ...DEFAULT_SETTINGS, ...normalise(settings) };

  await prisma.embed.upsert({
    where: { projectId },
    create: { projectId, token, ...merged },
    update: { token, ...merged },
  });

  increment("embeds_created");

  return embedState(projectId);
}

/** Changes what an existing embed shows, WITHOUT rotating its token.
 *
 *  Kept separate from `createEmbed` precisely because it does not rotate: an
 *  owner adjusting which file opens first must not silently break every snippet
 *  they have already pasted.
 */
export async function updateEmbed(
  rawProjectId: string,
  settings: Partial<EmbedSettings>,
): Promise<EmbedState> {
  const projectId = assertValidProjectId(rawProjectId);

  const existing = await prisma.embed.findUnique({ where: { projectId } });
  if (!existing) throw new NotFoundError("This project has no embed");

  await prisma.embed.update({
    where: { projectId },
    data: normalise(settings),
  });

  return embedState(projectId);
}

export async function revokeEmbed(rawProjectId: string): Promise<EmbedState> {
  const projectId = assertValidProjectId(rawProjectId);

  // deleteMany rather than delete: revoking an embed that is already gone is
  // the outcome the caller asked for, not an error.
  const { count } = await prisma.embed.deleteMany({ where: { projectId } });
  if (count > 0) increment("embeds_revoked");

  return embedState(projectId);
}

/** Only the fields actually supplied, each validated. */
function normalise(settings: Partial<EmbedSettings>): Partial<EmbedRow> {
  const out: Partial<EmbedRow> = {};

  if (settings.view !== undefined) {
    if (!isEmbedView(settings.view)) throw new BadRequestError("Unknown embed view");
    out.view = settings.view;
  }

  if (settings.preview !== undefined) {
    if (!isEmbedPreview(settings.preview)) {
      throw new BadRequestError("Unknown embed preview mode");
    }
    out.preview = settings.preview;
  }

  if (settings.activeFile !== undefined) {
    out.activeFile = settings.activeFile === null ? null : cleanPath(settings.activeFile);
  }

  return out;
}

/** A project-relative POSIX path, or a refusal.
 *
 *  Checked when it is STORED as well as when it is served. `resolveInProject`
 *  would catch a traversal at read time anyway, but a path that can never
 *  resolve has no business being persisted as somebody's default file.
 */
function cleanPath(raw: string): string {
  const value = raw.trim().replace(/^\/+/, "");

  if (value === "") return "";
  if (value.includes("\0") || value.includes("\\")) {
    throw new BadRequestError("Not a file path");
  }
  if (value.split("/").includes("..")) {
    throw new BadRequestError("Not a file path");
  }
  if (isSecretPath(value)) {
    throw new BadRequestError(
      "That file is never served through an embed. Pick another.",
      "EMBED_SECRET_PATH",
    );
  }

  return value;
}

/** What the owner's dialog shows: the token if there is one, the settings, and
 *  the two things they need in order to judge whether to publish at all. */
export async function embedState(rawProjectId: string): Promise<EmbedState> {
  const projectId = assertValidProjectId(rawProjectId);

  const [row, deployment] = await Promise.all([
    prisma.embed.findUnique({ where: { projectId } }),
    prisma.deployment.findUnique({
      where: { projectId },
      select: { deployedAt: true },
    }),
  ]);

  return {
    token: row?.token ?? null,
    settings: row ? toSettings(row) : DEFAULT_SETTINGS,
    hasDeployment: deployment?.deployedAt != null,
    // Named, not counted. "We hid 3 files" tells the owner nothing they can act
    // on; the list is what lets them notice the one that should not have been
    // in the project to begin with.
    hiddenPaths: (await listFiles(projectId)).hidden,
  };
}

/* ---- the reader's side ---- */

/** Resolves the token in the URL to a project, or refuses.
 *
 *  The shape check is not decoration. This value arrives from a public URL on
 *  an endpoint with no session behind it, and it is the single thing standing
 *  between a stranger and a project's source — so anything that is not the
 *  shape a token takes is rejected before it reaches the database at all.
 */
async function resolveToken(rawToken: string): Promise<{
  projectId: string;
  projectName: string;
  template: string;
  settings: EmbedSettings;
}> {
  if (!EMBED_TOKEN_PATTERN.test(rawToken)) {
    throw new NotFoundError("That embed is not available");
  }

  const row = await prisma.embed.findUnique({
    where: { token: rawToken },
    include: { project: { select: { id: true, name: true, template: true } } },
  });

  // The same answer for a revoked embed, a mistyped token and a project that
  // has been deleted. A public endpoint that distinguishes them is an oracle
  // for which tokens exist.
  if (!row) throw new NotFoundError("That embed is not available");

  return {
    projectId: row.project.id,
    projectName: row.project.name,
    template: row.project.template,
    settings: toSettings(row),
  };
}

/** Every file an embed may serve, and every one it refused to.
 *
 *  ONE function, used by both the listing and the file read, because the two
 *  must never disagree: a path missing from the listing but readable by asking
 *  for it directly is not hidden, it is merely unadvertised.
 */
async function listFiles(
  projectId: string,
): Promise<{ visible: EmbedFile[]; hidden: string[] }> {
  const visible: EmbedFile[] = [];
  const hidden: string[] = [];

  const walk = (node: TreeNodeData): void => {
    if (node.type === "file") {
      if (isSecretPath(node.relPath)) hidden.push(node.relPath);
      else visible.push({ relPath: node.relPath, size: node.size ?? 0 });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };

  // The tree already omits node_modules, .git, dist and the rest, which is the
  // right set here too: an embed showing somebody 5000 files of dependencies is
  // not showing them the project.
  walk(await buildFileTree(projectId));

  return { visible, hidden };
}

/** Everything the embed page renders, in one anonymous request. */
export async function embedPayload(rawToken: string): Promise<EmbedPayload> {
  const { projectId, projectName, template, settings } = await resolveToken(rawToken);

  const { visible } = await listFiles(projectId);

  increment("embed_views");

  return {
    projectName,
    template,
    view: settings.view,
    // Falls back rather than pointing at nothing: the owner's chosen file may
    // have been renamed or deleted since they chose it, and an embed opening on
    // an empty pane is a worse answer than one opening on the wrong file.
    activeFile:
      settings.activeFile && visible.some((f) => f.relPath === settings.activeFile)
        ? settings.activeFile
        : (visible[0]?.relPath ?? null),
    files: visible,
    previewUrl:
      settings.preview === "deployment" ? await deploymentUrl(projectId) : null,
    // Only useful to somebody who already has an account, and harmless to
    // somebody who does not: the editor route is behind auth either way.
    projectUrl: `${env.WEB_ORIGIN}/project/${projectId}`,
  };
}

/** The published site's address, or null if there is not one live.
 *
 *  Read at request time rather than stored on the embed, so taking a site
 *  offline empties the preview half of every embed of it immediately — which is
 *  what "offline" has to mean.
 */
async function deploymentUrl(projectId: string): Promise<string | null> {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId },
    select: { subdomain: true, deployedAt: true, status: true },
  });

  if (!deployment?.deployedAt || deployment.status !== "LIVE") return null;

  return siteUrl(deployment.subdomain);
}

/** One file's contents, for a reader who has clicked it.
 *
 *  Confined, size-capped and decoded as UTF-8 with replacement rather than
 *  refused: a stray byte in a source file should show as one bad character, not
 *  as an error page inside somebody's article.
 */
export async function embedFile(
  rawToken: string,
  rawPath: string,
): Promise<EmbedFileContents> {
  const { projectId } = await resolveToken(rawToken);

  const relPath = cleanPathForRead(rawPath);

  // Checked against the listing rather than only against the pattern. The
  // pattern is the rule, the listing is what was actually offered, and the two
  // agreeing is the property worth asserting on the path that returns bytes.
  const { visible } = await listFiles(projectId);
  if (!visible.some((file) => file.relPath === relPath)) {
    throw new NotFoundError("No such file in this embed");
  }

  const absolute = resolveInProject(projectId, relPath);

  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new NotFoundError("No such file in this embed");

  const handle = await readFile(absolute);
  const truncated = handle.byteLength > MAX_EMBED_FILE_BYTES;

  return {
    relPath,
    contents: handle
      .subarray(0, MAX_EMBED_FILE_BYTES)
      .toString("utf8"),
    truncated,
  };
}

/** The reader's path, which arrives from a query string.
 *
 *  Separate from `cleanPath` above because the failure mode differs: a bad path
 *  from an owner choosing a default is a mistake worth naming, while a bad path
 *  on the public endpoint is either a typo or a probe, and both get the same
 *  flat "no such file".
 */
function cleanPathForRead(raw: string): string {
  const value = raw.trim().replace(/^\/+/, "");

  if (
    value === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    isSecretPath(value)
  ) {
    increment("embed_path_rejected");
    throw new NotFoundError("No such file in this embed");
  }

  return value;
}
