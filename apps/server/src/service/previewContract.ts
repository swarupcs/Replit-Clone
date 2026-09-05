import { promises as fs } from "node:fs";
import path from "node:path";
import { TEMPLATE_FILES_ROOT, getTemplate } from "../templates/registry.js";
import { logger } from "../lib/logger.js";

/** Making a scaffolded project reachable by the preview proxy. plan.md §12.3's
 *  sibling defect, found on 2026-09-05 by loading a preview and getting
 *  "Preview unavailable".
 *
 *  **The problem in one sentence: "Latest" replaces the starter's files but
 *  keeps the template id, and the registry describes the starter.** The
 *  registry's own comment on `expectsPreviewBase` says as much — "the starter
 *  templates are written accordingly". So every fact it states about a project
 *  built by `npm create` is a guess, and three of them were wrong:
 *
 *  - The starter's `vite.config` binds `0.0.0.0`; a generated one does not, so
 *    the dev server listened on `[::1]:5173` inside the container and the
 *    proxy — which dials the container's address on the sandbox network — got
 *    connection refused. `HOST=0.0.0.0` is in the container's environment and
 *    Vite 8 ignores it, which is why the image's ENV did not save this.
 *  - The starter sets `base` from `PREVIEW_BASE`; a generated one serves at
 *    `/`. `expectsPreviewBase: true` makes the proxy forward `/preview/<id>/`
 *    unchanged, so every asset would have 404'd the moment the first problem
 *    was fixed.
 *  - The starter's HMR dials back through the proxied path. A generated one
 *    dials the container's own origin, which the browser cannot reach.
 *
 *  **So the generated config is replaced by the starter's, verbatim.** Copied
 *  rather than re-stated here, because the starter's is the one that is known
 *  to work and there is no value in a second copy that can drift from it. It
 *  reads `PREVIEW_BASE` from the environment, so one file serves every project
 *  of that template.
 *
 *  What this costs, said plainly: a "Latest" project carries a config this
 *  platform wrote rather than the one its generator produced. That is a real
 *  deviation from "latest", and it is the narrowest one available — the
 *  generated config holds nothing but the framework plugin, which the starter's
 *  holds too.
 *
 *  The dev script is rewritten as well, and the redundancy is deliberate: it is
 *  what the starters already do, and a flag on the command line survives
 *  somebody editing the config, which is a file we have just told them is
 *  theirs to edit.
 */

/** Where the preview proxy serves a project, when its template expects the app
 *  to know -- and null when the proxy strips the prefix instead.
 *
 *  The same string `containerManager` injects as `PREVIEW_BASE`, built the same
 *  way, because two spellings of one path is how the prefix and the app stop
 *  agreeing.
 *
 *  Null is a real answer and not an absence: it says "reachable, and serving at
 *  the root is correct". A caller that means "do not touch the command at all"
 *  passes nothing.
 */
export function previewBaseFor(
  templateId: string,
  projectId: string,
): string | null {
  return getTemplate(templateId).expectsPreviewBase
    ? `/preview/${projectId}/`
    : null;
}

export interface PreviewAdaptation {
  /** Copied from this template's committed starter into the project. */
  configFile: string;
  /** Every name the framework would accept, so the generated one cannot be
   *  left behind beside ours. Vite resolves `vite.config.js` before
   *  `vite.config.ts`, so writing ours as `.js` next to a generated `.ts`
   *  would work by luck, and the other way round would silently do nothing. */
  supersedes: string[];
  /** `scripts.dev`, rewritten to carry the same guarantees as flags. */
  devScript: string;
}

const VITE_CONFIGS = [
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
  "vite.config.cts",
];

const NEXT_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.cjs",
];

function vite(configFile: string): PreviewAdaptation {
  return {
    configFile,
    supersedes: VITE_CONFIGS,
    devScript: "vite --host 0.0.0.0 --port 5173",
  };
}

function next(): PreviewAdaptation {
  return {
    configFile: "next.config.mjs",
    supersedes: NEXT_CONFIGS,
    // Next reads `basePath` from its config; the host and port are the half a
    // config cannot state, and the starters pass them here for that reason.
    devScript: "next dev --hostname 0.0.0.0 --port 3000",
  };
}

/** Only the templates that can be built with "Latest" appear here.
 *
 *  Keyed by template id and defined in code rather than beside the recipes in
 *  the database, deliberately: a recipe is a list of commands the platform
 *  ships, and a row that could name a file to write into somebody's project
 *  would be a very different thing to hand a table. */
export const PREVIEW_ADAPTATIONS: Record<string, PreviewAdaptation> = {
  "react-vite": vite("vite.config.js"),
  "react-vite-ts": vite("vite.config.ts"),
  "vue-vite": vite("vite.config.js"),
  "svelte-vite": vite("vite.config.js"),
  nextjs: next(),
  "nextjs-ts": next(),
};

/** Rewrites `scripts.dev`, leaving the rest of the file as it was found.
 *
 *  Parsed and re-serialised rather than patched textually, because the file is
 *  JSON and a regex over somebody's `package.json` is how a project stops
 *  installing. Two spaces and a trailing newline is what every package manager
 *  writes, so this does not turn the next `npm install` into a whole-file diff.
 */
async function setDevScript(dir: string, devScript: string): Promise<boolean> {
  const file = path.join(dir, "package.json");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No package.json, or one that is not JSON. Nothing to do, and nothing
    // worth failing a finished scaffold over.
    return false;
  }

  const scripts =
    typeof parsed["scripts"] === "object" && parsed["scripts"] !== null
      ? (parsed["scripts"] as Record<string, unknown>)
      : {};

  // Only when the generator actually produced a dev script. Inventing one for
  // a project that has none would make `detectStartCommand` report a command
  // that runs nothing.
  if (typeof scripts["dev"] !== "string") return false;
  if (scripts["dev"] === devScript) return false;

  parsed["scripts"] = { ...scripts, dev: devScript };
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return true;
}

/** Makes what the scaffolder produced reachable by the preview proxy.
 *
 *  Never throws. A project that is built and running but whose preview needs a
 *  flag is a far better outcome than a project marked FAILED because a config
 *  file could not be copied — the scaffold itself succeeded, and that is what
 *  the status is about.
 */
export async function adaptForPreview(
  projectId: string,
  templateId: string,
  dir: string,
): Promise<void> {
  const adaptation = PREVIEW_ADAPTATIONS[templateId];
  if (!adaptation) return;

  try {
    const source = path.join(TEMPLATE_FILES_ROOT, templateId, adaptation.configFile);
    const config = await fs.readFile(source, "utf8");

    // Everything the framework would resolve, so exactly one config survives
    // and it is this one.
    for (const name of adaptation.supersedes) {
      await fs.rm(path.join(dir, name), { force: true });
    }

    await fs.writeFile(path.join(dir, adaptation.configFile), config, "utf8");
    const devChanged = await setDevScript(dir, adaptation.devScript);

    logger.info("adapted a scaffolded project for the preview proxy", {
      projectId,
      templateId,
      configFile: adaptation.configFile,
      devScript: devChanged,
    });
  } catch (error) {
    // Said out loud rather than swallowed: the preview will not work, and the
    // only way anybody finds out otherwise is by opening it.
    logger.error("could not adapt a scaffold for the preview", error, {
      projectId,
      templateId,
    });
  }
}
