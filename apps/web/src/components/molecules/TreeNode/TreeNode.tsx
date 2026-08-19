import type { MouseEvent } from "react";
import { IoIosArrowDown, IoIosArrowForward } from "react-icons/io";
import { FaFolder, FaFolderOpen } from "react-icons/fa";
import type { TreeNodeData } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useActiveFileTabStore } from "../../../store/activeFileTabStore.ts";

interface TreeNodeProps {
  node: TreeNodeData | null;
  depth?: number;
}

export const TreeNode = ({ node, depth = 0 }: TreeNodeProps) => {
  const { editorSocket } = useEditorSocketStore();
  const { expandedPaths, toggleExpanded } = useTreeStructureStore();
  const { activeFileTab } = useActiveFileTabStore();
  const { open: openContextMenu } = useFileContextMenuStore();

  if (!node) return null;

  const isFolder = node.type === "directory";
  // The root node is always expanded; it has no row of its own to click.
  const isExpanded = node.relPath === "" || expandedPaths.has(node.relPath);
  const isActive = activeFileTab?.relPath === node.relPath;

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!node) return;
    openContextMenu(event.clientX, event.clientY, node);
  }

  const rowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 8px",
    paddingLeft: `${8 + depth * 14}px`,
    cursor: "pointer",
    fontSize: "13px",
    color: isActive ? "#f8f8f2" : "#c8cad4",
    backgroundColor: isActive ? "#44475a" : "transparent",
    userSelect: "none",
    borderRadius: "4px",
  } as const;

  return (
    <div>
      {node.relPath !== "" && (
        <div
          style={rowStyle}
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
              {isExpanded ? (
                <IoIosArrowDown size={12} />
              ) : (
                <IoIosArrowForward size={12} />
              )}
              {isExpanded ? (
                <FaFolderOpen color="#f1fa8c" size={14} />
              ) : (
                <FaFolder color="#f1fa8c" size={14} />
              )}
            </>
          ) : (
            <>
              <span style={{ width: 12 }} />
              <FileIcon extension={fileExtension(node.name)} />
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

      {isFolder &&
        isExpanded &&
        node.children?.map((child) => (
          // Keyed by relPath: names alone collide across refetches.
          <TreeNode key={child.relPath} node={child} depth={depth + 1} />
        ))}
    </div>
  );
};
