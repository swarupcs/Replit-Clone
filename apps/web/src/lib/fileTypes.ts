import type { IconType } from "react-icons";
import { FaCss3Alt, FaFont, FaJava, FaLeaf } from "react-icons/fa";
import {
  SiAstro,
  SiDart,
  SiDocker,
  SiDotnet,
  SiGit,
  SiGnubash,
  SiGo,
  SiGraphql,
  SiHtml5,
  SiKotlin,
  SiLua,
  SiMarkdown,
  SiPerl,
  SiPhp,
  SiPrisma,
  SiPython,
  SiR,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiScala,
  SiSvelte,
  SiSwift,
  SiTerraform,
  SiToml,
  SiTypescript,
  SiVuedotjs,
  SiXml,
  SiYaml,
} from "react-icons/si";
import {
  VscDatabase,
  VscFile,
  VscFileBinary,
  VscFileMedia,
  VscFilePdf,
  VscFileZip,
  VscFolder,
  VscFolderOpened,
  VscGear,
  VscJson,
  VscLibrary,
  VscLock,
  VscOutput,
  VscPackage,
  VscRocket,
  VscSymbolFile,
  VscTerminal,
} from "react-icons/vsc";

/** What a file is, as one fact rather than two.
 *
 *  The icon map and the Monaco language map used to be separate, and they
 *  disagreed: the language map was the wider of the two, so a `.rs` file was
 *  syntax-highlighted as Rust underneath a generic file glyph. Two tables
 *  describing the same property will always drift, because nothing makes
 *  someone editing one open the other. So there is one table, and both
 *  accessors read from it.
 */
export interface FileType {
  /** Monaco language id, or `null` where the format genuinely has none.
   *
   *  `null` rather than a missing key, on purpose: a PNG having no language
   *  is a fact about PNGs, and writing it down is what distinguishes it from
   *  a language somebody forgot to fill in. The spec leans on exactly that
   *  distinction to catch the second case. */
  language: string | null;
  icon: IconType;
  color: string;
}

// Colours are the language's own wherever it has one people recognise,
// because that recognition is the whole job an icon does at 15px.
const JS = "#f7df1e";
const TS = "#3178c6";
const MUTED = "#a2a7bd";
const NEUTRAL = "#6b7192";
const MEDIA = "#a78bfa";
const DATA = "#fbbf24";

/** Extension -> what the file is. Keys are lowercase, without the dot. */
export const BY_EXTENSION: Record<string, FileType> = {
  // JavaScript and TypeScript
  js: { language: "javascript", icon: SiTypescript, color: JS },
  mjs: { language: "javascript", icon: SiTypescript, color: JS },
  cjs: { language: "javascript", icon: SiTypescript, color: JS },
  jsx: { language: "javascript", icon: SiReact, color: "#61dbfa" },
  ts: { language: "typescript", icon: SiTypescript, color: TS },
  mts: { language: "typescript", icon: SiTypescript, color: TS },
  cts: { language: "typescript", icon: SiTypescript, color: TS },
  tsx: { language: "typescript", icon: SiReact, color: TS },

  // Web
  html: { language: "html", icon: SiHtml5, color: "#e34c26" },
  htm: { language: "html", icon: SiHtml5, color: "#e34c26" },
  css: { language: "css", icon: FaCss3Alt, color: "#3c99dc" },
  scss: { language: "scss", icon: SiSass, color: "#cd6799" },
  sass: { language: "scss", icon: SiSass, color: "#cd6799" },
  less: { language: "less", icon: FaCss3Alt, color: "#1d365d" },
  // Monaco has no Vue, Svelte or Astro language; all three are close enough
  // to HTML that highlighting them as HTML beats highlighting them as
  // nothing, which is what they got before.
  vue: { language: "html", icon: SiVuedotjs, color: "#42b883" },
  svelte: { language: "html", icon: SiSvelte, color: "#ff3e00" },
  astro: { language: "html", icon: SiAstro, color: "#ff5d01" },

  // Data and config
  json: { language: "json", icon: VscJson, color: DATA },
  jsonc: { language: "json", icon: VscJson, color: DATA },
  json5: { language: "json", icon: VscJson, color: DATA },
  yaml: { language: "yaml", icon: SiYaml, color: MUTED },
  yml: { language: "yaml", icon: SiYaml, color: MUTED },
  toml: { language: "ini", icon: SiToml, color: "#9c4221" },
  ini: { language: "ini", icon: VscGear, color: NEUTRAL },
  cfg: { language: "ini", icon: VscGear, color: NEUTRAL },
  conf: { language: "ini", icon: VscGear, color: NEUTRAL },
  properties: { language: "ini", icon: VscGear, color: NEUTRAL },
  env: { language: "shell", icon: FaLeaf, color: "#4ade80" },
  // Monaco has no "svg" language; SVG is XML, and calling it otherwise meant
  // these silently got no highlighting at all.
  svg: { language: "xml", icon: VscFileMedia, color: "#ffb13b" },
  xml: { language: "xml", icon: SiXml, color: "#f1662a" },
  xsl: { language: "xml", icon: SiXml, color: "#f1662a" },
  csv: { language: "plaintext", icon: VscOutput, color: "#4ade80" },
  tsv: { language: "plaintext", icon: VscOutput, color: "#4ade80" },
  lock: { language: null, icon: VscLock, color: NEUTRAL },

  // Documentation
  md: { language: "markdown", icon: SiMarkdown, color: MUTED },
  mdx: { language: "markdown", icon: SiMarkdown, color: MUTED },
  markdown: { language: "markdown", icon: SiMarkdown, color: MUTED },
  txt: { language: "plaintext", icon: VscFile, color: NEUTRAL },
  rst: { language: "plaintext", icon: VscFile, color: NEUTRAL },
  pdf: { language: null, icon: VscFilePdf, color: "#f87171" },

  // Languages Monaco ships support for
  py: { language: "python", icon: SiPython, color: "#4b8bbe" },
  pyi: { language: "python", icon: SiPython, color: "#4b8bbe" },
  rb: { language: "ruby", icon: SiRuby, color: "#cc342d" },
  go: { language: "go", icon: SiGo, color: "#00add8" },
  rs: { language: "rust", icon: SiRust, color: "#dea584" },
  java: { language: "java", icon: FaJava, color: "#f89820" },
  kt: { language: "kotlin", icon: SiKotlin, color: "#7f52ff" },
  kts: { language: "kotlin", icon: SiKotlin, color: "#7f52ff" },
  swift: { language: "swift", icon: SiSwift, color: "#f05138" },
  c: { language: "c", icon: VscSymbolFile, color: "#659ad2" },
  h: { language: "c", icon: VscSymbolFile, color: "#659ad2" },
  cpp: { language: "cpp", icon: VscSymbolFile, color: "#00599c" },
  cc: { language: "cpp", icon: VscSymbolFile, color: "#00599c" },
  cxx: { language: "cpp", icon: VscSymbolFile, color: "#00599c" },
  hpp: { language: "cpp", icon: VscSymbolFile, color: "#00599c" },
  cs: { language: "csharp", icon: SiDotnet, color: "#512bd4" },
  php: { language: "php", icon: SiPhp, color: "#777bb4" },
  pl: { language: "perl", icon: SiPerl, color: "#0298c3" },
  lua: { language: "lua", icon: SiLua, color: "#000080" },
  r: { language: "r", icon: SiR, color: "#276dc3" },
  scala: { language: "scala", icon: SiScala, color: "#dc322f" },
  dart: { language: "dart", icon: SiDart, color: "#0175c2" },
  sql: { language: "sql", icon: VscDatabase, color: "#e38c00" },
  graphql: { language: "graphql", icon: SiGraphql, color: "#e10098" },
  gql: { language: "graphql", icon: SiGraphql, color: "#e10098" },
  // Monaco has no schema language for these three, but the icon is most of
  // what someone is looking for when scanning a tree for them.
  prisma: { language: "plaintext", icon: SiPrisma, color: "#5a67d8" },
  proto: { language: "plaintext", icon: VscSymbolFile, color: "#4285f4" },
  tf: { language: "plaintext", icon: SiTerraform, color: "#7b42bc" },
  tfvars: { language: "plaintext", icon: SiTerraform, color: "#7b42bc" },

  // Shell
  sh: { language: "shell", icon: SiGnubash, color: "#89e051" },
  bash: { language: "shell", icon: SiGnubash, color: "#89e051" },
  zsh: { language: "shell", icon: SiGnubash, color: "#89e051" },
  fish: { language: "shell", icon: SiGnubash, color: "#89e051" },
  ps1: { language: "powershell", icon: VscTerminal, color: "#012456" },

  // Formats with no language of their own, marked so rather than left out
  png: { language: null, icon: VscFileMedia, color: MEDIA },
  jpg: { language: null, icon: VscFileMedia, color: MEDIA },
  jpeg: { language: null, icon: VscFileMedia, color: MEDIA },
  gif: { language: null, icon: VscFileMedia, color: MEDIA },
  webp: { language: null, icon: VscFileMedia, color: MEDIA },
  avif: { language: null, icon: VscFileMedia, color: MEDIA },
  ico: { language: null, icon: VscFileMedia, color: MEDIA },
  mp4: { language: null, icon: VscFileMedia, color: MEDIA },
  webm: { language: null, icon: VscFileMedia, color: MEDIA },
  mp3: { language: null, icon: VscFileMedia, color: MEDIA },
  wav: { language: null, icon: VscFileMedia, color: MEDIA },
  woff: { language: null, icon: FaFont, color: MEDIA },
  woff2: { language: null, icon: FaFont, color: MEDIA },
  ttf: { language: null, icon: FaFont, color: MEDIA },
  otf: { language: null, icon: FaFont, color: MEDIA },
  zip: { language: null, icon: VscFileZip, color: DATA },
  gz: { language: null, icon: VscFileZip, color: DATA },
  tar: { language: null, icon: VscFileZip, color: DATA },
  wasm: { language: null, icon: VscFileBinary, color: "#654ff0" },
};

/** Whole filenames that carry more meaning than their extension does — and
 *  the dotfiles that have no extension at all. Matched case-insensitively,
 *  and consulted before the extension, so `Dockerfile.dev` is a Dockerfile
 *  rather than a `.dev` file. */
export const BY_NAME: Record<string, FileType> = {
  dockerfile: { language: "dockerfile", icon: SiDocker, color: "#2496ed" },
  containerfile: { language: "dockerfile", icon: SiDocker, color: "#2496ed" },
  "docker-compose.yml": { language: "yaml", icon: SiDocker, color: "#2496ed" },
  "docker-compose.yaml": { language: "yaml", icon: SiDocker, color: "#2496ed" },
  ".dockerignore": { language: "plaintext", icon: SiDocker, color: "#2496ed" },

  makefile: { language: "shell", icon: VscGear, color: "#6d8086" },
  procfile: { language: "shell", icon: VscRocket, color: "#79589f" },
  gemfile: { language: "ruby", icon: SiRuby, color: "#cc342d" },
  rakefile: { language: "ruby", icon: SiRuby, color: "#cc342d" },

  "package.json": { language: "json", icon: VscPackage, color: "#8bc500" },
  "package-lock.json": { language: "json", icon: VscLock, color: NEUTRAL },
  "pnpm-lock.yaml": { language: "yaml", icon: VscLock, color: NEUTRAL },
  "yarn.lock": { language: null, icon: VscLock, color: NEUTRAL },
  "cargo.lock": { language: "ini", icon: VscLock, color: NEUTRAL },
  "poetry.lock": { language: "ini", icon: VscLock, color: NEUTRAL },
  "requirements.txt": { language: "plaintext", icon: SiPython, color: "#4b8bbe" },
  "pyproject.toml": { language: "ini", icon: SiPython, color: "#4b8bbe" },
  "cargo.toml": { language: "ini", icon: SiRust, color: "#dea584" },
  "go.mod": { language: "plaintext", icon: SiGo, color: "#00add8" },
  "go.sum": { language: "plaintext", icon: VscLock, color: NEUTRAL },

  "tsconfig.json": { language: "json", icon: SiTypescript, color: TS },
  "jsconfig.json": { language: "json", icon: SiTypescript, color: JS },
  ".gitignore": { language: "plaintext", icon: SiGit, color: "#f05033" },
  ".gitattributes": { language: "plaintext", icon: SiGit, color: "#f05033" },
  ".gitmodules": { language: "ini", icon: SiGit, color: "#f05033" },
  ".npmrc": { language: "ini", icon: VscGear, color: "#cb3837" },
  ".nvmrc": { language: "plaintext", icon: VscGear, color: "#5fa04e" },
  ".editorconfig": { language: "ini", icon: VscGear, color: NEUTRAL },
  ".env": { language: "shell", icon: FaLeaf, color: "#4ade80" },
  ".bashrc": { language: "shell", icon: SiGnubash, color: "#89e051" },
  ".zshrc": { language: "shell", icon: SiGnubash, color: "#89e051" },
  license: { language: "plaintext", icon: VscFile, color: DATA },
  "readme.md": { language: "markdown", icon: VscLibrary, color: "#60a5fa" },
};

/** Folder name -> glyph.
 *
 *  The plan calls this the single change that most makes a tree look like VS
 *  Code, more than the file icons do — a folder is what someone actually
 *  scans for. Closed and open are separate glyphs: the chevron already says
 *  which state it is in, but the folder saying it too is what makes the state
 *  readable at a glance down a deep tree.
 */
export interface FolderType {
  closed: IconType;
  open: IconType;
  color: string;
}

const folder = (color: string): FolderType => ({
  closed: VscFolder,
  open: VscFolderOpened,
  color,
});

export const FOLDER_BY_NAME: Record<string, FolderType> = {
  src: folder("#60a5fa"),
  lib: folder("#60a5fa"),
  app: folder("#60a5fa"),
  components: folder("#22d3ee"),
  pages: folder("#22d3ee"),
  routes: folder("#22d3ee"),
  hooks: folder("#f472b6"),
  store: folder("#f472b6"),
  stores: folder("#f472b6"),
  context: folder("#f472b6"),
  utils: folder("#facc15"),
  helpers: folder("#facc15"),
  scripts: folder("#facc15"),
  config: folder("#94a3b8"),
  types: folder(TS),
  styles: folder("#cd6799"),
  assets: folder(MEDIA),
  images: folder(MEDIA),
  img: folder(MEDIA),
  fonts: folder(MEDIA),
  media: folder(MEDIA),
  public: folder("#4ade80"),
  static: folder("#4ade80"),
  test: folder("#f87171"),
  tests: folder("#f87171"),
  __tests__: folder("#f87171"),
  spec: folder("#f87171"),
  docs: folder(MUTED),
  doc: folder(MUTED),
  dist: folder(NEUTRAL),
  build: folder(NEUTRAL),
  out: folder(NEUTRAL),
  coverage: folder(NEUTRAL),
  node_modules: folder(NEUTRAL),
  ".git": folder("#f05033"),
  ".github": folder(MUTED),
  ".vscode": folder(TS),
  api: folder("#a78bfa"),
  server: folder("#a78bfa"),
  services: folder("#a78bfa"),
  service: folder("#a78bfa"),
  models: folder("#fb923c"),
  migrations: folder("#fb923c"),
  prisma: folder("#fb923c"),
  db: folder("#fb923c"),
  database: folder("#fb923c"),
  controllers: folder("#c084fc"),
  middleware: folder("#c084fc"),
  middlewares: folder("#c084fc"),
};

export const DEFAULT_FOLDER: FolderType = folder(NEUTRAL);
export const DEFAULT_FILE: FileType = {
  language: null,
  icon: VscFile,
  color: NEUTRAL,
};

/** The one lookup both the icon and the language read from.
 *
 *  Name first, for the reason the name map exists at all: `Dockerfile.dev`
 *  should be a Dockerfile, not a `.dev` file. */
export const fileTypeFor = (
  extension: string | undefined,
  name?: string,
): FileType | undefined => {
  if (name) {
    const lower = name.toLowerCase();
    const byName = BY_NAME[lower] ?? BY_NAME[lower.split(".")[0] ?? ""];
    if (byName) return byName;

    // `.env.local`, `.env.production` and friends.
    if (lower.startsWith(".env")) return BY_NAME[".env"];
  }

  if (!extension) return undefined;
  return BY_EXTENSION[extension.toLowerCase()];
};

export const folderTypeFor = (name: string): FolderType =>
  FOLDER_BY_NAME[name.toLowerCase()] ?? DEFAULT_FOLDER;
