/** A node in a project's file tree.
 *
 *  NOTE (Phase 0): this mirrors what the `directory-tree` package emits today,
 *  including `path`, which is an ABSOLUTE HOST PATH. Phase 2 replaces `path`
 *  with a project-relative `relPath` so host paths never reach a client.
 */
export interface TreeNodeData {
  name: string;
  /** Absolute host path (see note above). */
  path: string;
  size: number;
  /** Present on files only, e.g. ".ts". Absent on directories. */
  extension?: string;
  type?: "file" | "directory";
  /** Present on directories only — this is how a folder is detected today. */
  children?: TreeNodeData[];
}

export function isDirectory(node: TreeNodeData): boolean {
  return Array.isArray(node.children);
}
