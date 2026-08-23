import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Input, Modal } from "antd";
import type { TreeNodeData } from "@replit-clone/shared";
import "./FileContextMenu.css";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { fileDownloadUrl } from "../../../apis/projects.ts";
import {
  selectOrderedSelection,
  useTreeSelectionStore,
} from "../../../store/treeSelectionStore.ts";
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
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  const projectId = useTreeStructureStore((state) => state.projectId);
  /** What Delete will act on: the selection when this row is part of one,
   *  otherwise just this row. */
  // useShallow is essential, not decoration: selectOrderedSelection builds a
  // NEW array every call (visibleOrder.filter). zustand v5 compares snapshots
  // with Object.is, so a fresh array each render reads as a change and loops
  // forever -- React's "getSnapshot should be cached". useShallow compares the
  // array's contents instead, so an unchanged selection is seen as unchanged.
  const selection = useTreeSelectionStore(useShallow(selectOrderedSelection));
  const treeStructure = useTreeStructureStore((state) => state.treeStructure);

  /** Which paths are folders, so a delete emits the right event for each.
   *  Derived from the tree rather than guessed from the name — a file can be
   *  called anything, including something that looks like a directory. */
  const folderPaths = useMemo(() => {
    const paths = new Set<string>();

    const walk = (entry: TreeNodeData) => {
      if (entry.type === "directory") {
        if (entry.relPath) paths.add(entry.relPath);
        entry.children?.forEach(walk);
      }
    };

    if (treeStructure) walk(treeStructure);
    return paths;
  }, [treeStructure]);

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

    if (action === "delete") {
      // The selection when this row is part of one; otherwise just this row.
      setDeleteTargets(
        selection.includes(node.relPath) ? selection : [node.relPath],
      );
    }

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
  /** Everything Delete will remove. Captured when the dialog opens so it
   *  cannot change underneath the confirmation the user is reading. */
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);

  function confirmDelete() {
    if (!editorSocket || !target) return;
    if (isDeletingFolder && name.trim() !== confirmWord) return;

    for (const relPath of deleteTargets) {
      // A folder and a file are different events; the tree knows which each
      // path is, so ask it rather than guessing from the name.
      const isFolder = folderPaths.has(relPath);
      editorSocket.emit(isFolder ? "deleteFolder" : "deleteFile", { relPath });
    }

    useTreeSelectionStore.getState().clear();
    closeDialog();
  }

  /** Confirmation is required whenever a folder is involved, because that is
   *  the case where one slip destroys work that exists nowhere else. */
  const isDeletingFolder =
    pending === "delete" && deleteTargets.some((path) => folderPaths.has(path));
  const confirmWord = deleteTargets.length > 1 ? "delete" : (target?.name ?? "");
  const deleteBlocked = isDeletingFolder && name.trim() !== confirmWord;

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
              {deleteTargets.length > 1 ? (
                <>
                  Delete <b>{deleteTargets.length} items</b>
                  {isDeletingFolder ? ", including folders and everything inside them" : ""}?
                </>
              ) : (
                <>
                  Delete <b>{target?.name}</b>
                  {isDeletingFolder ? " and everything inside it" : ""}?
                </>
              )}{" "}
              This removes them from disk and cannot be undone.
            </span>

            {/* A folder can hold work that exists nowhere else, so removing one
                takes more than a click in the same place the menu just was. */}
            {isDeletingFolder && (
              <Input
                autoFocus
                value={name}
                placeholder={`Type "${confirmWord}" to confirm`}
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
