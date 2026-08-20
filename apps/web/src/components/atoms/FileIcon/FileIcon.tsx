import type { ReactNode } from "react";
import { FaCss3Alt, FaHtml5, FaJs, FaLeaf } from "react-icons/fa";
import {
  SiDocker,
  SiGit,
  SiMarkdown,
  SiPython,
  SiReact,
  SiSass,
  SiTypescript,
  SiYaml,
} from "react-icons/si";
import { VscFile, VscFileMedia, VscJson, VscLock } from "react-icons/vsc";

const SIZE = 15;

/** Extension -> icon.
 *
 *  Keys are lowercased extensions; `byName` below handles the dotfiles and
 *  fixed filenames that have no meaningful extension. */
const BY_EXTENSION: Record<string, ReactNode> = {
  js: <FaJs color="#f7df1e" size={SIZE} />,
  mjs: <FaJs color="#f7df1e" size={SIZE} />,
  cjs: <FaJs color="#f7df1e" size={SIZE} />,
  jsx: <SiReact color="#61dbfa" size={SIZE} />,
  ts: <SiTypescript color="#3178c6" size={SIZE} />,
  mts: <SiTypescript color="#3178c6" size={SIZE} />,
  cts: <SiTypescript color="#3178c6" size={SIZE} />,
  tsx: <SiReact color="#3178c6" size={SIZE} />,

  css: <FaCss3Alt color="#3c99dc" size={SIZE} />,
  scss: <SiSass color="#cd6799" size={SIZE} />,
  sass: <SiSass color="#cd6799" size={SIZE} />,
  html: <FaHtml5 color="#e34c26" size={SIZE} />,

  json: <VscJson color="#fbbf24" size={SIZE} />,
  md: <SiMarkdown color="#a2a7bd" size={SIZE} />,
  mdx: <SiMarkdown color="#a2a7bd" size={SIZE} />,

  py: <SiPython color="#4b8bbe" size={SIZE} />,
  yml: <SiYaml color="#a2a7bd" size={SIZE} />,
  yaml: <SiYaml color="#a2a7bd" size={SIZE} />,
  env: <FaLeaf color="#4ade80" size={SIZE} />,

  svg: <VscFileMedia color="#ffb13b" size={SIZE} />,
  png: <VscFileMedia color="#a78bfa" size={SIZE} />,
  jpg: <VscFileMedia color="#a78bfa" size={SIZE} />,
  jpeg: <VscFileMedia color="#a78bfa" size={SIZE} />,
  gif: <VscFileMedia color="#a78bfa" size={SIZE} />,
  webp: <VscFileMedia color="#a78bfa" size={SIZE} />,
  ico: <VscFileMedia color="#a78bfa" size={SIZE} />,
};

/** Whole filenames that carry more meaning than their extension does. */
const BY_NAME: Record<string, ReactNode> = {
  "package.json": <VscJson color="#8bc500" size={SIZE} />,
  "package-lock.json": <VscLock color="#6b7192" size={SIZE} />,
  "pnpm-lock.yaml": <VscLock color="#6b7192" size={SIZE} />,
  "yarn.lock": <VscLock color="#6b7192" size={SIZE} />,
  "requirements.txt": <SiPython color="#4b8bbe" size={SIZE} />,
  dockerfile: <SiDocker color="#2496ed" size={SIZE} />,
  ".dockerignore": <SiDocker color="#2496ed" size={SIZE} />,
  ".gitignore": <SiGit color="#f05033" size={SIZE} />,
  ".gitattributes": <SiGit color="#f05033" size={SIZE} />,
  ".env": <FaLeaf color="#4ade80" size={SIZE} />,
  ".env.local": <FaLeaf color="#4ade80" size={SIZE} />,
  ".env.example": <FaLeaf color="#4ade80" size={SIZE} />,
};

interface FileIconProps {
  extension: string | undefined;
  /** Full filename, when available -- lets `package.json` and `.gitignore`
   *  render distinctly from any other .json / extensionless file. */
  name?: string;
}

/** Always renders something.
 *
 *  Previously only four extensions were mapped and everything else rendered
 *  `null`, so most rows in a real project had no icon at all and their labels
 *  sat at a different indent from their neighbours'. */
export const FileIcon = ({ extension, name }: FileIconProps) => {
  const byName = name ? BY_NAME[name.toLowerCase()] : undefined;
  const byExtension = extension ? BY_EXTENSION[extension.toLowerCase()] : undefined;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: SIZE,
        height: SIZE,
        flex: "none",
      }}
    >
      {byName ?? byExtension ?? <VscFile color="#6b7192" size={SIZE} />}
    </span>
  );
};
