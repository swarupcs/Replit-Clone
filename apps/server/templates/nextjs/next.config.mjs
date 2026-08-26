// The preview proxy serves this app under /preview/<projectId>/. Next emits
// absolute asset URLs (/_next/...), which would escape that prefix, so it has
// to be told about it. `basePath` must NOT have a trailing slash, while
// PREVIEW_BASE does — hence the trim.
const basePath = (process.env.PREVIEW_BASE ?? "").replace(/\/$/, "");

// Set by the deploy build, and only by it. A static deployment has no Node
// process behind it, so Next has to emit plain files into `out/` rather than
// the server bundle in `.next/` that `next start` would need. It is deliberately
// NOT on by default: `next dev` in export mode loses the API routes and the
// image optimiser that a project may well be using while it is being written.
const staticExport = process.env.STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
export default {
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  ...(staticExport
    ? {
        output: "export",
        // The optimiser is a request-time service. Without a server there is
        // nothing to run it, and the build fails rather than degrading.
        images: { unoptimized: true },
      }
    : {}),
};
