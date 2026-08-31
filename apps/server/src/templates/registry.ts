import path from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestError } from "../utils/errors.js";

export interface TemplateDefinition {
  id: string;
  label: string;
  /** Docker image, built by `pnpm images:build`. */
  image: string;
  /** Port the dev server listens on INSIDE the container, and the one the
   *  preview proxy targets by default. No host port is ever published. */
  devPort: number;
  /** Other ports a project of this kind commonly listens on — an API beside a
   *  frontend, a database UI, a docs server. The preview can be pointed at any
   *  of them; the registry used to allow exactly one. */
  extraPorts?: number[];
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
  /** A database this template needs, provisioned when a project is created
   *  from it. Absent for templates that need none.
   *
   *  On the template AND on the project (see `Project.database`): a user who
   *  started from React and then needed a database should not have to start
   *  over, which is exactly what a template-only design forces. */
  database?: "postgres";
  /** How this template produces a directory of files that can be served by a
   *  plain static host, or absent when it cannot.
   *
   *  Absent is the honest answer for anything that needs a process at request
   *  time -- Express, Flask, FastAPI, Go. Those templates carry
   *  `serviceDeploy` instead. */
  staticBuild?: StaticBuild;
  /** How this template is published when it has no static output: a command
   *  that does not terminate, and the port it listens on.
   *
   *  Exactly one of `staticBuild` and `serviceDeploy` should be present. A
   *  template with neither cannot be published at all, and a test holds that
   *  every template has one of them so a new one cannot quietly ship
   *  unpublishable. */
  serviceDeploy?: ServiceDeploy;
  /** What the test panel runs by default, inside the project's container.
   *
   *  Optional, and absent is a real answer rather than a gap: `static-html`
   *  has nothing to test, and a template that guessed would run a command that
   *  fails for a reason the person reading the output cannot act on. A project
   *  may override it with `Project.testCommand`.
   *
   *  These are the commands the starter files actually support. A JS template
   *  ships no test runner, so `npm test` here would fail on a fresh project --
   *  which is the honest outcome and says what to do next ("no test script"),
   *  where inventing `vitest run` would fail with a command-not-found nobody
   *  asked for. */
  testCommand?: string;
}

export interface ServiceDeploy {
  /** Install and serve, run inside the deployment's own container.
   *
   *  Not the same string as `startCommand`, and the differences are the point:
   *  no file watcher (a published app has no editor writing to it, and a
   *  reloader is a way for it to fall over at 3am), and dev dependencies
   *  omitted where the package manager can express it. */
  command: string;
  /** Where the process listens INSIDE its container. The public origin
   *  reverse-proxies here; nothing is ever published to the host. */
  port: number;
}

export interface StaticBuild {
  /** Run inside the project's container. Empty for a template that IS its own
   *  output and has nothing to build. */
  command: string;
  /** Read afterwards, relative to the project root. "." means the tree
   *  itself. */
  outputDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Starter files live next to the source, not in dist, so they survive a build
 *  without needing a copy step. */
export const TEMPLATE_FILES_ROOT = path.resolve(here, "../../templates");

export const TEMPLATES: Record<string, TemplateDefinition> = {
  "react-vite": {
    id: "react-vite",
    testCommand: "npm test",
    label: "React (Vite)",
    image: "sandbox-node:latest",
    devPort: 5173,
    // A Vite app very often has an API beside it on 3000.
    extraPorts: [3000, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "react-vite",
    staticBuild: { command: "npm install && npm run build", outputDir: "dist" },
    expectsPreviewBase: true,
  },
  "react-vite-ts": {
    id: "react-vite-ts",
    testCommand: "npm test",
    label: "React (Vite) + TypeScript",
    image: "sandbox-node:latest",
    devPort: 5173,
    extraPorts: [3000, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "react-vite-ts",
    staticBuild: { command: "npm install && npm run build", outputDir: "dist" },
    expectsPreviewBase: true,
  },
  "node-express": {
    id: "node-express",
    testCommand: "npm test",
    label: "Node (Express)",
    image: "sandbox-node:latest",
    devPort: 3000,
    extraPorts: [5173, 8080],
    startCommand: "npm install && npm start",
    filesDir: "node-express",
    // `node server.js`, not `npm start` -- this template's start script is
    // `node --watch server.js`, and a file watcher behind a published app is
    // a process that restarts itself over a tree nothing is writing to.
    serviceDeploy: {
      command: "npm install --omit=dev && node server.js",
      port: 3000,
    },
    expectsPreviewBase: false,
  },
  "node-express-postgres": {
    id: "node-express-postgres",
    testCommand: "npm test",
    label: "Node (Express + Postgres)",
    image: "sandbox-node:latest",
    devPort: 3000,
    extraPorts: [5173, 8080],
    // The migration is in the serve half, after the first `&&`, so warm start
    // keeps running it on every start rather than only on the first install.
    // That is what a migration should do — which is why schema.sql is
    // idempotent.
    startCommand: "npm install && npm run migrate && npm start",
    filesDir: "node-express-postgres",
    // The migration runs on every start, as it does in development, and
    // schema.sql is idempotent. The deployed app reads DATABASE_URL from the
    // project's own environment -- it shares the project's database rather
    // than getting one of its own, which is a decision worth knowing about.
    // Plain `node` for the same watcher reason given on `node-express`.
    serviceDeploy: {
      command: "npm install --omit=dev && node migrate.js && node server.js",
      port: 3000,
    },
    expectsPreviewBase: false,
    // No staticBuild, deliberately. A database-backed app serves requests
    // from a running process; offering a static deploy button and then
    // producing a site with no data behind it would be worse than saying no.
    database: "postgres",
  },
  "node-express-ts": {
    id: "node-express-ts",
    testCommand: "npm test",
    label: "Node (Express) + TypeScript",
    image: "sandbox-node:latest",
    devPort: 3000,
    extraPorts: [5173, 8080],
    // tsx runs the TypeScript directly and reloads on save, so there is no
    // build step between editing a file and seeing the result.
    startCommand: "npm install && npm start",
    filesDir: "node-express-ts",
    // Dev dependencies are kept, unlike the other Node templates: tsx runs
    // the TypeScript directly rather than compiling it, so it is what serves
    // the app in production too and `--omit=dev` would remove the runtime.
    serviceDeploy: {
      command: "npm install && npx tsx src/server.ts",
      port: 3000,
    },
    expectsPreviewBase: false,
  },
  "static-html": {
    id: "static-html",
    label: "Static HTML",
    image: "sandbox-node:latest",
    devPort: 8080,
    extraPorts: [3000, 5173],
    startCommand: "serve -l 8080 .",
    filesDir: "static-html",
    staticBuild: { command: "", outputDir: "." },
    expectsPreviewBase: false,
  },
  "nextjs": {
    id: "nextjs",
    testCommand: "npm test",
    label: "Next.js",
    image: "sandbox-node:latest",
    devPort: 3000,
    extraPorts: [5173, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "nextjs",
    staticBuild: { command: "npm install && npm run build", outputDir: "out" },
    // Next emits absolute /_next/... asset URLs, so it is told the prefix
    // through basePath rather than having it stripped.
    expectsPreviewBase: true,
  },
  "nextjs-ts": {
    id: "nextjs-ts",
    testCommand: "npm test",
    label: "Next.js + TypeScript",
    image: "sandbox-node:latest",
    devPort: 3000,
    extraPorts: [5173, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "nextjs-ts",
    staticBuild: { command: "npm install && npm run build", outputDir: "out" },
    // Same reason as the JavaScript template: absolute /_next/... URLs mean
    // the prefix has to be configured, not stripped.
    expectsPreviewBase: true,
  },
  "vue-vite": {
    id: "vue-vite",
    testCommand: "npm test",
    label: "Vue (Vite)",
    image: "sandbox-node:latest",
    devPort: 5173,
    extraPorts: [3000, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "vue-vite",
    staticBuild: { command: "npm install && npm run build", outputDir: "dist" },
    expectsPreviewBase: true,
  },
  "svelte-vite": {
    id: "svelte-vite",
    testCommand: "npm test",
    label: "Svelte (Vite)",
    image: "sandbox-node:latest",
    devPort: 5173,
    extraPorts: [3000, 8080],
    startCommand: "npm install && npm run dev",
    filesDir: "svelte-vite",
    staticBuild: { command: "npm install && npm run build", outputDir: "dist" },
    expectsPreviewBase: true,
  },
  "python-flask": {
    id: "python-flask",
    testCommand: "pytest",
    label: "Python (Flask)",
    image: "sandbox-python:latest",
    devPort: 5000,
    extraPorts: [8000, 8080],
    startCommand: "pip install -r requirements.txt && python app.py",
    filesDir: "python-flask",
    // gunicorn rather than `python app.py`, which starts Flask's development
    // server -- single-threaded, reloading, and it prints a warning telling
    // you not to do exactly this. Installed alongside the project's own
    // requirements rather than written into the template's requirements.txt:
    // it is this platform's choice of production server and has no business
    // appearing in a tree the user is reading.
    serviceDeploy: {
      command:
        "pip install -r requirements.txt gunicorn && " +
        "gunicorn -b 0.0.0.0:5000 -w 2 app:app",
      port: 5000,
    },
    expectsPreviewBase: false,
  },
  "python-fastapi": {
    id: "python-fastapi",
    testCommand: "pytest",
    label: "Python (FastAPI)",
    image: "sandbox-python:latest",
    devPort: 8000,
    extraPorts: [5000, 8080],
    startCommand:
      "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000 --reload",
    filesDir: "python-fastapi",
    // Without --reload. The dev command watches the tree; a published app
    // has nothing writing to its tree and a watcher is only a way to fall
    // over unattended.
    serviceDeploy: {
      command:
        "pip install -r requirements.txt && " +
        "uvicorn main:app --host 0.0.0.0 --port 8000",
      port: 8000,
    },
    expectsPreviewBase: false,
  },
  "go-http": {
    id: "go-http",
    testCommand: "go test ./...",
    label: "Go (net/http)",
    image: "sandbox-go:latest",
    devPort: 8080,
    extraPorts: [3000, 8000],
    startCommand: "go run .",
    filesDir: "go-http",
    // Built once rather than `go run .`, which recompiles into a temporary
    // binary and keeps the toolchain resident behind the server.
    serviceDeploy: {
      command: "go build -o /tmp/server . && /tmp/server",
      port: 8080,
    },
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
