import fsp from "node:fs/promises";
import path from "node:path";
import type {
  BrowserPreviewPlan,
  BrowserPreviewRefusal,
} from "@replit-clone/shared";
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_FILES } from "@replit-clone/shared";
import { getTemplate } from "../templates/registry.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { projectRoot } from "../utils/projectPaths.js";

/** Deciding whether a project can be previewed without a container, and
 *  gathering what a browser would need to do it. plan.md §13.2.
 *
 *  **The eligibility answer is the hard part, not the bundling.** A browser can
 *  build a React app; it cannot run `node-express`. Getting that wrong in the
 *  permissive direction produces a preview that renders a blank page for
 *  reasons the reader cannot see — which is worse than saying no, because the
 *  reader concludes the project is broken.
 *
 *  So the rule is an ALLOWLIST of templates rather than a deny-list of servers.
 *  A template this file has not heard of is refused: a new one is far more
 *  likely to be another kind of server than another front end, and a wrong
 *  refusal costs a fallback to the container preview that already works.
 */

/** Templates a browser can build and run.
 *
 *  Named individually. `static-html` needs no bundler at all; the three Vite
 *  ones are plain client-rendered apps. Next.js is deliberately ABSENT even
 *  though it is a front-end framework: it has a server, server components and
 *  a router that runs on it, and "previews except for the half of the app that
 *  is server-rendered" is not a preview.
 */
const SUPPORTED_TEMPLATES = new Set([
  "static-html",
  "react-vite",
  "react-vite-ts",
  "vue-vite",
  "svelte-vite",
]);

/** Files worth sending. Everything else in a project tree is either build
 *  output, a dependency, or not source. */
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".html",
  ".svelte",
  ".vue",
]);

/** Directories never walked. `node_modules` is the important one and the rest
 *  are the same list every other walk in this repository uses. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "__pycache__",
  ".venv",
]);

/** Where a bundle might start, in the order they are tried. */
const ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/main.jsx",
  "src/main.js",
  "src/index.tsx",
  "src/index.ts",
  "src/index.jsx",
  "src/index.js",
  "index.html",
  "index.js",
];

const REFUSALS: Record<BrowserPreviewRefusal, string> = {
  "needs-a-server":
    "This project runs a server, so it needs a container. The preview beside the editor is the one that can show it.",
  "needs-services":
    "This project declares services in docker-compose.yml, which a browser cannot run.",
  "no-entry":
    "No entry file was found. A browser preview starts from src/main.tsx, src/index.js or index.html.",
  "too-large":
    "There is more source here than a browser preview ships. The container preview has no such limit.",
};

function refuse(reason: BrowserPreviewRefusal): BrowserPreviewPlan {
  return { supported: false, reason, message: REFUSALS[reason] };
}

/** Every bare import in a source file.
 *
 *  Deliberately a regex rather than a parse. The worker resolves these from a
 *  CDN and a missed one becomes a build error the reader sees, not a security
 *  problem — whereas parsing every file with a real parser on the server is
 *  work this endpoint should not do to save the browser a fetch it makes
 *  anyway.
 */
export function bareImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"'.][^"']*)["']/g,
    /\bimport\s+["']([^"'.][^"']*)["']/g,
    /\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      // Not a URL and not a path. Anything else is a package name, including
      // scoped ones and deep imports like `react-dom/client`.
      if (name && !name.startsWith("http") && !name.startsWith("/")) {
        found.add(name);
      }
    }
  }

  return [...found].sort();
}

interface Walked {
  files: Record<string, string>;
  bytes: number;
  truncated: boolean;
}

async function walk(root: string): Promise<Walked> {
  const files: Record<string, string> = {};
  let bytes = 0;
  let truncated = false;

  const visit = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return;

    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (truncated) return;

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

      const relPath = `${prefix}${entry.name}`;
      const absolute = path.join(dir, entry.name);

      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat) continue;

      // Checked BEFORE reading. A single enormous file should not be read into
      // memory to discover it is too big to send.
      if (bytes + stat.size > MAX_PREVIEW_BYTES) {
        truncated = true;
        return;
      }
      if (Object.keys(files).length >= MAX_PREVIEW_FILES) {
        truncated = true;
        return;
      }

      const contents = await fsp.readFile(absolute, "utf8").catch(() => null);
      if (contents === null) continue;

      files[relPath] = contents;
      bytes += stat.size;
    }
  };

  await visit(root, "");
  return { files, bytes, truncated };
}

/** Whether a project can be previewed in the browser, and what to send if so. */
export async function planBrowserPreview(
  projectId: string,
): Promise<BrowserPreviewPlan> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { template: true },
  });

  if (!project || !SUPPORTED_TEMPLATES.has(project.template)) {
    return refuse("needs-a-server");
  }

  const root = projectRoot(projectId);

  // A compose file means services, whatever the template says. Checked before
  // the walk because it is one `stat` and it settles the question.
  for (const name of ["docker-compose.yml", "docker-compose.yaml"]) {
    const exists = await fsp
      .stat(path.join(root, name))
      .then(() => true)
      .catch(() => false);
    if (exists) return refuse("needs-services");
  }

  const walked = await walk(root);
  if (walked.truncated) return refuse("too-large");

  const entry = ENTRY_CANDIDATES.find((candidate) => candidate in walked.files);
  if (entry === undefined) return refuse("no-entry");

  const dependencies = new Set<string>();
  for (const [relPath, contents] of Object.entries(walked.files)) {
    if (/\.(?:[jt]sx?|mjs|cjs|svelte|vue)$/.test(relPath)) {
      for (const name of bareImports(contents)) dependencies.add(name);
    }
  }

  logger.debug("planned a browser preview", {
    projectId,
    files: Object.keys(walked.files).length,
    dependencies: dependencies.size,
  });

  return {
    supported: true,
    entry,
    files: walked.files,
    dependencies: [...dependencies].sort(),
    html: walked.files["index.html"],
  };
}

/** Exported for the template registry's own sake: a template added later
 *  should be considered rather than silently inheriting a refusal. */
export function isPreviewableTemplate(templateId: string): boolean {
  // Reads the registry so a template id that no longer exists is not quietly
  // treated as supported.
  try {
    getTemplate(templateId);
  } catch {
    return false;
  }
  return SUPPORTED_TEMPLATES.has(templateId);
}
