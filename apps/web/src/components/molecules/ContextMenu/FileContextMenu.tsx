import { useEffect, useRef, useState } from "react";
import { Input, Modal } from "antd";
import "./FileContextMenu.css";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

type PendingAction = "newFile" | "newFolder" | "rename";

const ACTION_COPY: Record<PendingAction, { title: string; okText: string }> = {
  newFile: { title: "New file", okText: "Create" },
  newFolder: { title: "New folder", okText: "Create" },
  rename: { title: "Rename", okText: "Rename" },
};

export const FileContextMenu = () => {
  const { x, y, isOpen, node, close } = useFileContextMenuStore();
  const { editorSocket } = useEditorSocketStore();

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [name, setName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on any outside click or Escape, rather than the old onMouseLeave
  // which fired the moment the pointer clipped a corner.
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, close]);

  if (!node) return null;

  const isFolder = node.type === "directory";
  /** New entries land inside a folder, or beside a file. */
  const parentPath = isFolder
    ? node.relPath
    : node.relPath.split("/").slice(0, -1).join("/");

  function startAction(action: PendingAction) {
    setPending(action);
    setName(action === "rename" ? (node?.name ?? "") : "");
    close();
  }

  function confirmAction() {
    const trimmed = name.trim();
    if (!trimmed || !editorSocket || !node) return;

    const childPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;

    if (pending === "newFile") {
      editorSocket.emit("createFile", { relPath: childPath });
    } else if (pending === "newFolder") {
      editorSocket.emit("createFolder", { relPath: childPath });
    } else if (pending === "rename") {
      editorSocket.emit("renameEntry", {
        relPath: node.relPath,
        newName: trimmed,
      });
    }

    setPending(null);
    setName("");
  }

  function handleDelete() {
    if (!editorSocket || !node) return;

    if (node.type === "directory") {
      editorSocket.emit("deleteFolder", { relPath: node.relPath });
    } else {
      editorSocket.emit("deleteFile", { relPath: node.relPath });
    }
    close();
  }

  return (
    <>
      {isOpen && (
        <div ref={menuRef} className="fileContextOptionsWrapper" style={{ left: x, top: y }}>
          <button className="fileContextButton" onClick={() => startAction("newFile")}>
            New file
          </button>
          <button className="fileContextButton" onClick={() => startAction("newFolder")}>
            New folder
          </button>
          <button className="fileContextButton" onClick={() => startAction("rename")}>
            Rename
          </button>
          <button className="fileContextButton fileContextButtonDanger" onClick={handleDelete}>
            Delete
          </button>
        </div>
      )}

      <Modal
        open={pending !== null}
        title={pending ? ACTION_COPY[pending].title : ""}
        okText={pending ? ACTION_COPY[pending].okText : "OK"}
        onOk={confirmAction}
        onCancel={() => setPending(null)}
        okButtonProps={{ disabled: !name.trim() }}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={name}
          placeholder="name"
          onChange={(event) => setName(event.target.value)}
          onPressEnter={confirmAction}
        />
      </Modal>
    </>
  );
};
