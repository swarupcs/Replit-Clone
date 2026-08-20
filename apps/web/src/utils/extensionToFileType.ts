/** Maps a file to a Monaco language id.
 *
 *  The previous map covered ten extensions, which left the shipped Python
 *  template's `app.py` rendering as plain text — under a Python icon, since
 *  FileIcon already knew about far more than this did. Anything absent here
 *  falls back to plain text, which is the right answer for an unknown format
 *  but a poor one for a language Monaco supports out of the box.
 */
const extensionToTypeMap: Record<string, string> = {
  // JavaScript and TypeScript
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  vue: "html",
  svelte: "html",

  // Data and config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "shell",
  // Monaco has no "svg" language; SVG is XML, and calling it otherwise meant
  // these silently got no highlighting at all.
  svg: "xml",
  xml: "xml",
  xsl: "xml",
  csv: "plaintext",

  // Documentation
  md: "markdown",
  mdx: "markdown",

  // Other languages Monaco ships support for
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  scala: "scala",
  dart: "dart",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",

  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
};

/** Files whose name carries more meaning than their extension does — or that
 *  have no extension at all. Matched case-insensitively. */
const nameToTypeMap: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  procfile: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
  ".gitignore": "plaintext",
  ".dockerignore": "plaintext",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
};

export const extensionToFileType = (
  extension: string | undefined,
  name?: string,
): string | undefined => {
  // Name first: "Dockerfile.dev" should be a Dockerfile, not a ".dev" file.
  if (name) {
    const lower = name.toLowerCase();
    const byName =
      nameToTypeMap[lower] ?? nameToTypeMap[lower.split(".")[0] ?? ""];
    if (byName) return byName;

    // `.env.local`, `.env.production` and friends.
    if (lower.startsWith(".env")) return "shell";
  }

  if (!extension) return undefined;
  return extensionToTypeMap[extension.toLowerCase()];
};
