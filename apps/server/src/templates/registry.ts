import path from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestError } from "../utils/errors.js";

export interface TemplateDefinition {
  id: string;
  label: string;
  /** Docker image, built by `pnpm images:build`. */
  image: string;
  /** Port the dev server listens on INSIDE the container. The preview proxy
   *  targets this; no host port is ever published. */
  devPort: number;
  /** Shown in the UI so the user knows what to run. */
  startCommand: string;
  /** True when the dev server is configured to serve under the proxy's
   *  /preview/<projectId>/ prefix (Vite's `base`), so the proxy must forward
   *  the path unchanged. False for servers that expect to be at the root, in
   *  which case the proxy strips the prefix.
   *
   *  Prefix-stripping only works for apps whose assets use relative URLs; an
   *  absolute "/styles.css" would escape the prefix. The starter templates are
   *  written accordingly. */
  expectsPreviewBase: boolean;
  /** Directory under `templates/files` copied into a new project. */
  filesDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Starter files live next to the source, not in dist, so they survive a build
 *  without needing a copy step. */
export const TEMPLATE_FILES_ROOT = path.resolve(here, "../../templates");

export const TEMPLATES: Record<string, TemplateDefinition> = {
  "react-vite": {
    id: "react-vite",
    label: "React (Vite)",
    image: "sandbox-node:latest",
    devPort: 5173,
    startCommand: "npm install && npm run dev",
    filesDir: "react-vite",
    expectsPreviewBase: true,
  },
  "node-express": {
    id: "node-express",
    label: "Node (Express)",
    image: "sandbox-node:latest",
    devPort: 3000,
    startCommand: "npm install && npm start",
    filesDir: "node-express",
    expectsPreviewBase: false,
  },
  "static-html": {
    id: "static-html",
    label: "Static HTML",
    image: "sandbox-node:latest",
    devPort: 8080,
    startCommand: "npx --yes serve -l 8080 .",
    filesDir: "static-html",
    expectsPreviewBase: false,
  },
  "python-flask": {
    id: "python-flask",
    label: "Python (Flask)",
    image: "sandbox-python:latest",
    devPort: 5000,
    startCommand: "pip install -r requirements.txt && python app.py",
    filesDir: "python-flask",
    expectsPreviewBase: false,
  },
};

export const DEFAULT_TEMPLATE_ID = "react-vite";

export function getTemplate(id: string): TemplateDefinition {
  const template = TEMPLATES[id];
  if (!template) {
    throw new BadRequestError(`Unknown template "${id}"`, "UNKNOWN_TEMPLATE");
  }
  return template;
}

export function listTemplates(): TemplateDefinition[] {
  return Object.values(TEMPLATES);
}
