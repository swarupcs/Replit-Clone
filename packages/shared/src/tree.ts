/** A node in a project's file tree.
 *
 *  Paths are ALWAYS relative to the project root and POSIX-style. The server
 *  previously sent absolute host paths (straight from `directory-tree`), which
 *  is what made the client send absolute paths back for every file operation.
 */
export interface TreeNodeData {
  name: string;
  /** POSIX path relative to the project root, e.g. "src/main.tsx".
   *  The root node itself has "". */
  relPath: string;
  type: "file" | "directory";
  /** Present on directories only. */
  children?: TreeNodeData[];
  /** Bytes; files only. */
  size?: number;
}

/** Bare extension without the dot, or undefined for extensionless names. */
export function fileExtension(name: string): string | undefined {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1) : undefined;
}
