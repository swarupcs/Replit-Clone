import { useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { IoIosArrowForward } from "react-icons/io";
import { FaFolder, FaFolderOpen } from "react-icons/fa";
import type { TreeNodeData } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

interface TreeNodeProps {
  node: TreeNodeData | null;
  depth?: number;
}

export const TreeNode = ({ node, depth = 0 }: TreeNodeProps) => {
  const { editorSocket } = useEditorSocketStore();
  const { expandedPaths, toggleExpanded } = useTreeStructureStore();
  const activeRelPath = useOpenTabsStore((state) => state.activeRelPath);
  const { open: openContextMenu } = useFileContextMenuStore();
  /** Highlighted while something is being dragged over this row. */
  const [dropping, setDropping] = useState(false);

  if (!node) return null;

  const isFolder = node.type === "directory";
  // The root node is always expanded; it has no row of its own to click.
  const isExpanded = node.relPath === "" || expandedPaths.has(node.relPath);
  const isActive = activeRelPath === node.relPath;

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!node) return;
    openContextMenu(event.clientX, event.clientY, node);
  }

  /** The folder this row represents as a drop target: itself when it is a
   *  folder, otherwise the folder it sits in. */
  function dropTarget(): string {
    if (!node) return "";
    return isFolder ? node.relPath : node.relPath.split("/").slice(0, -1).join("/");
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);

    const source = event.dataTransfer.getData("text/rc-path");
    if (!source || !node) return;

    const destDir = dropTarget();

    // Dropping something back where it already is, or a folder onto itself.
    const currentDir = source.split("/").slice(0, -1).join("/");
    if (source === node.relPath || currentDir === destDir) return;

    editorSocket?.emit("moveEntry", { relPath: source, destDir });
  }

  return (
    <div>
      {node.relPath !== "" && (
        <div
          className="rc-tree-row"
          data-active={isActive}
          data-dropping={dropping}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          draggable
          onDragStart={(event) => {
            // A custom type, so a drag from elsewhere in the page cannot be
            // mistaken for one of ours.
            event.dataTransfer.setData("text/rc-path", node.relPath);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("text/rc-path")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={handleDrop}
          onContextMenu={handleContextMenu}
          onClick={() => {
            if (isFolder) {
              toggleExpanded(node.relPath);
            } else {
              // Single click opens, matching every real editor. It used to
              // require a double click.
              editorSocket?.emit("readFile", { relPath: node.relPath });
            }
          }}
        >
          {isFolder ? (
            <>
              {/* One chevron that rotates, rather than two swapped glyphs --
                  the rotation makes expand/collapse legible as a transition. */}
              <IoIosArrowForward
                size={11}
                className="rc-tree-chevron"
                data-expanded={isExpanded}
              />
              {isExpanded ? (
                <FaFolderOpen color="#7c88b8" size={14} style={{ flex: "none" }} />
              ) : (
                <FaFolder color="#7c88b8" size={14} style={{ flex: "none" }} />
              )}
            </>
          ) : (
            <>
              <span style={{ width: 11, flex: "none" }} />
              <FileIcon extension={fileExtension(node.name)} name={node.name} />
            </>
          )}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.name}
          </span>
        </div>
      )}

      {isFolder && isExpanded && node.children && node.children.length > 0 && (
        // Indent guide: a hairline at this level's depth, so a deeply nested
        // file can be traced back to its folder.
        <div
          className={depth >= 0 && node.relPath !== "" ? "rc-tree-branch" : undefined}
          style={
            node.relPath !== ""
              ? ({ "--rc-guide-x": `${14 + depth * 14}px` } as CSSProperties)
              : undefined
          }
        >
          {node.children.map((child) => (
            // Keyed by relPath: names alone collide across refetches.
            <TreeNode key={child.relPath} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};
