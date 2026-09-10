import type { BrowserPreviewPlan } from "@replit-clone/shared";

/** Building a project in the reader's own browser. plan.md §13.2.
 *
 *  esbuild compiled to WebAssembly, with a plugin that resolves imports two
 *  ways: relative ones out of the files the server sent, and bare ones from a
 *  CDN. There is no server-side process at any point after the source is
 *  fetched, which is the entire point — an embed on a busy page costs this host
 *  one text response per reader rather than one container per reader.
 *
 *  **Why esbuild-wasm rather than a hand-written resolver.** Real projects
 *  contain JSX, TypeScript, and imports that need extension resolution; a
 *  half-bundler produces a preview that works for the example and fails for
 *  the project, which is the worst outcome for a feature whose audience is
 *  somebody who did not write the code.
 *
 *  **The CDN is a real dependency and is named as one.** Bare imports resolve
 *  through esm.sh, which means a reader with no route to it gets a build error
 *  rather than a blank page — see `describeFailure`.
 */

/** Where bare imports come from.
 *
 *  esm.sh rather than unpkg or jsdelivr, because it serves ES modules with
 *  their own dependencies already rewritten — which is what makes a
 *  single-pass resolver possible at all. A bundler that had to walk a package's
 *  own `node_modules` graph in the browser is a much larger thing than this
 *  row.
 */
const CDN = "https://esm.sh";

export interface BundleResult {
  /** The built JavaScript, ready to run in an iframe. */
  code: string;
  /** Anything esbuild said that is worth showing. */
  warnings: string[];
}

export class BundleError extends Error {}

/** Turns esbuild's failure into a sentence a reader can act on. */
export function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  // The one failure that is not about the code: no route to the CDN. Named,
  // because "Could not resolve react" sends somebody to look at their imports.
  if (/Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED/i.test(text)) {
    return `Could not reach ${CDN} to fetch this project's dependencies. A browser preview needs it; the container preview does not.`;
  }
  return text;
}

/** esbuild's own initialisation, done once per page.
 *
 *  Kept as a promise rather than a boolean: two panes mounting at once would
 *  otherwise both see "not started" and call `initialize` twice, which esbuild
 *  refuses with an error that reads like a bug in this file.
 */
let ready: Promise<typeof import("esbuild-wasm")> | null = null;

async function esbuild(): Promise<typeof import("esbuild-wasm")> {
  ready ??= (async () => {
    const module = await import("esbuild-wasm");
    await module.initialize({
      // Served from this origin rather than a CDN: the wasm binary is the one
      // piece that must load for anything to work, and making it depend on a
      // third party would put the whole feature behind somebody else's uptime.
      wasmURL: new URL("esbuild-wasm/esbuild.wasm", import.meta.url).href,
      worker: true,
    });
    return module;
  })();

  return ready;
}

/** For a test, and for a hot reload that would otherwise re-initialise. */
export function resetBundlerForTests(): void {
  ready = null;
}

/** Resolves an import against the files the server sent.
 *
 *  Extension resolution is why this exists: `./App` in a real project means
 *  `./App.tsx`, and a resolver that only tried the literal path would fail on
 *  every project written the ordinary way.
 */
export function resolveRelative(
  from: string,
  specifier: string,
  files: Record<string, string>,
): string | null {
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const joined = normalise(base ? `${base}/${specifier}` : specifier);

  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.mjs`,
    `${joined}.css`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.js`,
    `${joined}/index.jsx`,
  ];

  return candidates.find((candidate) => candidate in files) ?? null;
}

/** `a/./b` and `a/../b`, resolved without a URL — these are project-relative
 *  paths and putting them through `new URL` would need a base origin that means
 *  nothing here. */
function normalise(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** The loader esbuild should use for a file, from its extension. */
export function loaderFor(relPath: string): "ts" | "tsx" | "js" | "jsx" | "css" | "json" {
  if (relPath.endsWith(".tsx")) return "tsx";
  if (relPath.endsWith(".ts")) return "ts";
  if (relPath.endsWith(".jsx")) return "jsx";
  if (relPath.endsWith(".css")) return "css";
  if (relPath.endsWith(".json")) return "json";
  return "js";
}

export async function bundle(plan: BrowserPreviewPlan): Promise<BundleResult> {
  if (!plan.supported || !plan.entry || !plan.files) {
    throw new BundleError(plan.message ?? "This project cannot be previewed here.");
  }

  const files = plan.files;
  const entry = plan.entry;
  const build = await esbuild();

  const result = await build.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    // Nothing is minified: the reader may well open devtools, and this is a
    // preview of somebody's source rather than a production build.
    minify: false,
    // Development, because that is what these projects' own dev servers set
    // and what their code branches on.
    define: { "process.env.NODE_ENV": '"development"' },
    jsx: "automatic",
    plugins: [
      {
        name: "rc-project-files",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === entry) return { path: entry, namespace: "rc" };

            if (args.path.startsWith(".")) {
              const resolved = resolveRelative(args.importer, args.path, files);
              if (resolved === null) {
                return {
                  errors: [
                    { text: `Could not find ${args.path} imported by ${args.importer}` },
                  ],
                };
              }
              return { path: resolved, namespace: "rc" };
            }

            // A bare import. External rather than fetched-and-inlined: esm.sh
            // serves modules that already reference their own dependencies by
            // URL, so letting the browser fetch them keeps this to one pass.
            return { path: `${CDN}/${args.path}`, external: true };
          });

          pluginBuild.onLoad({ filter: /.*/, namespace: "rc" }, (args) => ({
            contents: files[args.path] ?? "",
            loader: loaderFor(args.path),
          }));
        },
      },
    ],
  });

  const code = result.outputFiles?.[0]?.text;
  if (code === undefined) throw new BundleError("The build produced nothing.");

  return {
    code,
    warnings: result.warnings.map((warning) => warning.text),
  };
}

/** The document the iframe runs.
 *
 *  Built here rather than by the server: it is a function of the bundle, and
 *  the bundle only exists in the browser. The project's own `index.html` is
 *  used when it has one, with its `<script type=module src=...>` replaced —
 *  keeping the author's `<head>`, their stylesheet links and their root
 *  element, which is where a Vite project puts things the app needs.
 */
export function previewDocument(code: string, html?: string): string {
  const script = `<script type="module">\n${code}\n</script>`;

  if (html === undefined) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>${script}</body></html>`;
  }

  // The author's own module script is what this replaces: it points at a path
  // only their dev server can serve, so leaving it would produce a 404 in the
  // iframe beside a working bundle.
  const stripped = html.replace(
    /<script\b[^>]*type=["']module["'][^>]*><\/script>/gi,
    "",
  );

  return stripped.includes("</body>")
    ? stripped.replace("</body>", `${script}</body>`)
    : `${stripped}${script}`;
}
