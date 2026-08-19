import type { MouseEvent } from "react";
import "./FileContextMenu.css";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

interface FileContextMenuProps {
  x: number;
  y: number;
  path: string;
}

export const FileContextMenu = ({ x, y, path }: FileContextMenuProps) => {
  const { setIsOpen } = useFileContextMenuStore();
  const { editorSocket } = useEditorSocketStore();

  function handleFileDelete(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    editorSocket?.emit("deleteFile", { pathToFileOrFolder: path });
    setIsOpen(false);
  }

  return (
    <div
      onMouseLeave={() => setIsOpen(false)}
      className="fileContextOptionsWrapper"
      style={{ left: x, top: y }}
    >
      <button className="fileContextButton" onClick={handleFileDelete}>
        Delete File
      </button>
      <button className="fileContextButton">Rename File</button>
    </div>
  );
};
