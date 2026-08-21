// The preview proxy serves this app under /preview/<projectId>/. Next emits
// absolute asset URLs (/_next/...), which would escape that prefix, so it has
// to be told about it. `basePath` must NOT have a trailing slash, while
// PREVIEW_BASE does — hence the trim.
const basePath = (process.env.PREVIEW_BASE ?? "").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
export default {
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};
