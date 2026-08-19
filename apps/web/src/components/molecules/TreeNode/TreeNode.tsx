import { useState } from "react";
import type { MouseEvent } from "react";
import { IoIosArrowDown, IoIosArrowForward } from "react-icons/io";
import type { TreeNodeData } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";

interface TreeNodeProps {
  fileFolderData: TreeNodeData | null;
}

function computeExtension(node: TreeNodeData): string | undefined {
  const parts = node.name.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}

export const TreeNode = ({ fileFolderData }: TreeNodeProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const { editorSocket } = useEditorSocketStore();
  const {
    setFile,
    setIsOpen: setFileContextMenuIsOpen,
    setX: setFileContextMenuX,
    setY: setFileContextMenuY,
  } = useFileContextMenuStore();

  if (!fileFolderData) return null;

  const children = fileFolderData.children;
  const isFolder = Array.isArray(children);

  function handleDoubleClick(node: TreeNodeData) {
    editorSocket?.emit("readFile", { pathToFileOrFolder: node.path });
  }

  function handleContextMenuForFiles(e: MouseEvent, path: string) {
    e.preventDefault();
    setFile(path);
    setFileContextMenuX(e.clientX);
    setFileContextMenuY(e.clientY);
    setFileContextMenuIsOpen(true);
  }

  return (
    <div style={{ paddingLeft: "15px", color: "white" }}>
      {isFolder ? (
        <button
          onClick={() => setIsExpanded((prev) => !prev)}
          style={{
            border: "none",
            cursor: "pointer",
            outline: "none",
            color: "white",
            backgroundColor: "transparent",
            padding: "15px",
            fontSize: "16px",
            marginTop: "10px",
          }}
        >
          {isExpanded ? <IoIosArrowDown /> : <IoIosArrowForward />}
          {fileFolderData.name}
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "start",
          }}
        >
          <FileIcon extension={computeExtension(fileFolderData)} />
          <p
            style={{
              paddingTop: "15px",
              paddingBottom: "15px",
              marginTop: "8px",
              fontSize: "15px",
              cursor: "pointer",
              marginLeft: "18px",
            }}
            onContextMenu={(e) =>
              handleContextMenuForFiles(e, fileFolderData.path)
            }
            onDoubleClick={() => handleDoubleClick(fileFolderData)}
          >
            {fileFolderData.name}
          </p>
        </div>
      )}

      {isExpanded &&
        children?.map((child) => (
          // Keyed by path, not name — sibling names are unique but names alone
          // collide across the remounts React does when the tree refetches.
          <TreeNode fileFolderData={child} key={child.path} />
        ))}
    </div>
  );
};
