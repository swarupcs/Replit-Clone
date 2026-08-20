import { useEffect, useRef, useState } from "react";
import { Input, Modal } from "antd";
import type { TreeNodeData } from "@replit-clone/shared";
import "./FileContextMenu.css";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { fileDownloadUrl } from "../../../apis/projects.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

type PendingAction = "newFile" | "newFolder" | "rename" | "delete";

const ACTION_COPY: Record<PendingAction, { title: string; okText: string }> = {
  newFile: { title: "New file", okText: "Create" },
  newFolder: { title: "New folder", okText: "Create" },
  rename: { title: "Rename", okText: "Rename" },
  delete: { title: "Delete", okText: "Delete" },
};

export const FileContextMenu = () => {
  const { x, y, isOpen, node, close } = useFileContextMenuStore();
  const { editorSocket } = useEditorSocketStore();
  const projectId = useTreeStructureStore((state) => state.projectId);

  /** The node the dialog is acting on.
   *
   *  Deliberately a local copy rather than the store's `node`: opening a dialog
   *  also closes the menu, and `close()` clears that node. Reading it from the
   *  store meant the render that should have shown the dialog bailed out at the
   *  null guard instead, so New file, New folder and Rename all did nothing —
   *  and the stale `pending` then made a dialog appear on the NEXT right-click.
   */
  const [target, setTarget] = useState<TreeNodeData | null>(null);
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

  function startAction(action: PendingAction) {
    if (!node) return;
    setTarget(node);
    setPending(action);
    setName(action === "rename" ? node.name : "");

    close();
  }

  function closeDialog() {
    setPending(null);
    setTarget(null);
    setName("");
  }

  function confirmAction() {
    const trimmed = name.trim();
    if (!trimmed || !editorSocket || !target) return;

    /** New entries land inside a folder, or beside a file. */
    const parentPath =
      target.type === "directory"
        ? target.relPath
        : target.relPath.split("/").slice(0, -1).join("/");
    const childPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;

    if (pending === "newFile") {
      editorSocket.emit("createFile", { relPath: childPath });
    } else if (pending === "newFolder") {
      editorSocket.emit("createFolder", { relPath: childPath });
    } else if (pending === "rename") {
      editorSocket.emit("renameEntry", {
        relPath: target.relPath,
        newName: trimmed,
      });
    }

    closeDialog();
  }

  /** Deletion is recursive on the server and has no undo, so it always
   *  confirms. A folder additionally has to be named, the way destructive
   *  actions elsewhere do — one slipped click used to be enough to destroy a
   *  whole source tree. */
  function confirmDelete() {
    if (!editorSocket || !target) return;
    if (target.type === "directory" && name.trim() !== target.name) return;

    if (target.type === "directory") {
      editorSocket.emit("deleteFolder", { relPath: target.relPath });
    } else {
      editorSocket.emit("deleteFile", { relPath: target.relPath });
    }

    closeDialog();
  }

  const isDeletingFolder = pending === "delete" && target?.type === "directory";
  const deleteBlocked = isDeletingFolder && name.trim() !== target.name;

  return (
    <>
      {isOpen && node && (
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
          {node.type === "file" && projectId && (
            <button
              className="fileContextButton"
              onClick={() => {
                // A real navigation, so the browser honours the filename the
                // server sends in Content-Disposition.
                window.location.assign(fileDownloadUrl(projectId, node.relPath));
                close();
              }}
            >
              Download
            </button>
          )}
          <button
            className="fileContextButton fileContextButtonDanger"
            onClick={() => startAction("delete")}
          >
            Delete
          </button>
        </div>
      )}

      <Modal
        open={pending !== null}
        title={pending ? ACTION_COPY[pending].title : ""}
        okText={pending ? ACTION_COPY[pending].okText : "OK"}
        onOk={pending === "delete" ? confirmDelete : confirmAction}
        onCancel={closeDialog}
        okButtonProps={
          pending === "delete"
            ? { danger: true, disabled: deleteBlocked }
            : { disabled: !name.trim() }
        }
        destroyOnHidden
      >
        {pending === "delete" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ color: "var(--rc-text-muted)" }}>
              Delete <b>{target?.name}</b>
              {isDeletingFolder ? " and everything inside it" : ""}? This
              removes it from disk and cannot be undone.
            </span>

            {/* A folder can hold work that exists nowhere else, so removing one
                takes more than a click in the same place the menu just was. */}
            {isDeletingFolder && (
              <Input
                autoFocus
                value={name}
                placeholder={`Type "${target.name}" to confirm`}
                onChange={(event) => setName(event.target.value)}
                onPressEnter={confirmDelete}
              />
            )}
          </div>
        ) : (
          <Input
            autoFocus
            value={name}
            placeholder="name"
            onChange={(event) => setName(event.target.value)}
            onPressEnter={confirmAction}
          />
        )}
      </Modal>
    </>
  );
};
