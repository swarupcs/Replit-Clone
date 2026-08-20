import type { EditorNamespace } from "../socketHandlers/editorHandler.js";
import { detectExternalChange, liveDocPaths } from "./collabService.js";

/** Tells anyone editing a file that it changed underneath them.
 *
 *  Separate from the watcher itself so the watcher stays about the file tree,
 *  and separate from collabService so that stays free of socket concerns.
 */
export async function reportExternalChanges(
  projectId: string,
  editorNamespace: EditorNamespace,
): Promise<void> {
  for (const relPath of liveDocPaths(projectId)) {
    if (!(await detectExternalChange(projectId, relPath))) continue;

    editorNamespace
      .to(`${projectId}:doc:${relPath}`)
      .emit("docExternalChange", { relPath });
  }
}
