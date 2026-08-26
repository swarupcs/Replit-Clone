import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Input, Spin, Tooltip, message } from "antd";
import {
  VscCloudUpload,
  VscCollapseAll,
  VscNewFile,
  VscNewFolder,
  VscRefresh,
} from "react-icons/vsc";
import type { TreeNodeData } from "@replit-clone/shared";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { TreeNode } from "../../molecules/TreeNode/TreeNode.tsx";
import { FileContextMenu } from "../../molecules/ContextMenu/FileContextMenu.tsx";
import { NewEntryPrompt } from "../../molecules/ContextMenu/NewEntryPrompt.tsx";
import { uploadFilesApi } from "../../../apis/projects.ts";
import { useTreeSelectionStore } from "../../../store/treeSelectionStore.ts";
import { treeKeyAction } from "../../../lib/treeKeys.ts";

/** Prunes the tree to nodes whose path matches `query`, keeping the folders
 *  that lead to a match so the result still reads as a tree rather than a flat
 *  list. Returns null when nothing under this node matches. */
function filterTree(node: TreeNodeData, query: string): TreeNodeData | null {
  const selfMatches = node.name.toLowerCase().includes(query);

  if (node.type !== "directory") return selfMatches ? node : null;

  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNodeData => child !== null);

  // A matching folder keeps its whole subtree; a non-matching one survives
  // only as a path to its matching descendants.
  if (selfMatches) return node;
  if (children.length > 0) return { ...node, children };
  return null;
}

/** The rows as they appear on screen, top to bottom.
 *
 *  A shift-click range has to mean what the user sees, so it is measured
 *  against this rather than against the tree's own recursion — a collapsed
 *  folder's children are not on screen and must not be swept up in a range.
 */
function visibleRows(
  node: TreeNodeData,
  expanded: Set<string>,
  into: string[] = [],
): string[] {
  if (node.relPath) into.push(node.relPath);

  const isOpen = node.relPath === "" || expanded.has(node.relPath);
  if (node.type === "directory" && isOpen) {
    node.children?.forEach((child) => visibleRows(child, expanded, into));
  }

  return into;
}

/** Every folder path in the tree -- used to expand everything while filtering,
 *  since a match hidden inside a collapsed folder is not a useful result. */
function folderPaths(node: TreeNodeData, into: string[] = []): string[] {
  if (node.type === "directory") {
    if (node.relPath) into.push(node.relPath);
    node.children?.forEach((child) => folderPaths(child, into));
  }
  return into;
}

export const TreeStructure = () => {
  // The panel genuinely needs the tree itself, so it re-renders when the tree
  // changes — but not for everything else in these two stores.
  const treeStructure = useTreeStructureStore((state) => state.treeStructure);
  const projectId = useTreeStructureStore((state) => state.projectId);
  const refreshTree = useTreeStructureStore((state) => state.refreshTree);
  const collapseAll = useTreeStructureStore((state) => state.collapseAll);
  const revealPaths = useTreeStructureStore((state) => state.revealPaths);
  const toggleExpanded = useTreeStructureStore((state) => state.toggleExpanded);
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  /** A hidden input, because a styled button cannot open a file picker on its
   *  own. */
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !projectId) return;

    setUploading(true);
    try {
      const paths = await uploadFilesApi(projectId, [...files]);
      await refreshTree();
      void messageApi.success(
        `Uploaded ${String(paths.length)} file${paths.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      const detail = (
        error as { response?: { data?: { message?: string } } }
      ).response?.data?.message;
      void messageApi.error(detail ?? "Could not upload those files.");
    } finally {
      setUploading(false);
      // Cleared so choosing the same file twice in a row still fires a change.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  useEffect(() => {
    if (projectId && !treeStructure) void refreshTree();
  }, [projectId, treeStructure, refreshTree]);

  const expandedPaths = useTreeStructureStore((state) => state.expandedPaths);
  const setVisibleOrder = useTreeSelectionStore((state) => state.setVisibleOrder);

  const trimmedQuery = query.trim().toLowerCase();

  const visibleTree = useMemo(() => {
    if (!treeStructure) return null;
    if (!trimmedQuery) return treeStructure;
    return filterTree(treeStructure, trimmedQuery);
  }, [treeStructure, trimmedQuery]);

  // Republished whenever the tree or what is expanded changes, so a range
  // selection is always measured against what is actually on screen.
  useEffect(() => {
    setVisibleOrder(visibleTree ? visibleRows(visibleTree, expandedPaths) : []);
  }, [visibleTree, expandedPaths, setVisibleOrder]);

  // Filtering is useless against collapsed folders, so reveal every path that
  // survived the filter.
  //
  // In ONE update. This used to loop over `revealPath`, which is a store write
  // -- and so a render -- per folder. React stops at 50 nested updates, so
  // filtering a project with that many folders crashed the tree rather than
  // filtering it.
  useEffect(() => {
    if (!trimmedQuery || !visibleTree) return;
    revealPaths(folderPaths(visibleTree));
  }, [trimmedQuery, visibleTree, revealPaths]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshTree();
    } finally {
      setRefreshing(false);
    }
  }

  /** The scrolling list of rows. Keyboard navigation is handled here rather
   *  than on each row: the rules need the whole visible order, and a row is
   *  memoised precisely so it does not re-render when focus moves. */
  const rowsRef = useRef<HTMLDivElement>(null);

  /** Moves real DOM focus, which is what makes the roving tab stop work — the
   *  store follows via the row's own `onFocus`.
   *
   *  Matched by walking the rows rather than with a selector, because a path is
   *  a filename and may contain anything a filename may. */
  function focusRow(relPath: string) {
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>("[data-rc-path]");
    for (const row of rows ?? []) {
      if (row.dataset["rcPath"] === relPath) {
        row.focus();
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-rc-path]",
    );
    if (!row) return;

    const from = row.dataset["rcPath"];
    const kind = row.dataset["rcKind"];
    if (!from || (kind !== "file" && kind !== "directory")) return;

    const selection = useTreeSelectionStore.getState();
    const action = treeKeyAction({
      key: event.key,
      from,
      kind,
      isExpanded: expandedPaths.has(from),
      visibleOrder: selection.visibleOrder,
    });

    if (!action) return;
    // Only once a key is known to mean something here: Space scrolls the pane
    // and the arrows move the scroll box, both of which would fight the tree.
    event.preventDefault();

    switch (action.kind) {
      case "focus":
        focusRow(action.relPath);
        break;

      case "expand":
      case "collapse":
        toggleExpanded(action.relPath);
        break;

      case "activate":
        // The same two calls the click handler makes, so a keyboard open and a
        // mouse open cannot mean different things.
        selection.click(from, { meta: false, shift: false });
        if (kind === "directory") toggleExpanded(from);
        else editorSocket?.emit("readFile", { relPath: from });
        break;
    }
  }

  function handleCreate(name: string) {
    if (!editorSocket || !creating) return;
    // Root-level creation: the context menu handles the nested cases.
    editorSocket.emit(creating === "file" ? "createFile" : "createFolder", {
      relPath: name,
    });
    setCreating(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {contextHolder}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => void handleUpload(event.target.files)}
      />

      <div className="rc-pane-label" style={{ justifyContent: "space-between" }}>
        <span>Explorer</span>

        <span style={{ display: "flex", gap: 2 }}>
          <Tooltip title="New file">
            <button
              className="rc-icon-button"
              onClick={() => setCreating("file")}
              aria-label="New file"
            >
              <VscNewFile size={14} />
            </button>
          </Tooltip>
          <Tooltip title="New folder">
            <button
              className="rc-icon-button"
              onClick={() => setCreating("folder")}
              aria-label="New folder"
            >
              <VscNewFolder size={14} />
            </button>
          </Tooltip>
          <Tooltip title="Upload files">
            <button
              className="rc-icon-button"
              data-spinning={uploading}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload files"
            >
              <VscCloudUpload size={14} />
            </button>
          </Tooltip>
          <Tooltip title="Refresh">
            <button
              className="rc-icon-button"
              data-spinning={refreshing}
              onClick={() => void handleRefresh()}
              aria-label="Refresh"
            >
              <VscRefresh size={14} />
            </button>
          </Tooltip>
          <Tooltip title="Collapse all">
            <button
              className="rc-icon-button"
              onClick={collapseAll}
              aria-label="Collapse all"
            >
              <VscCollapseAll size={14} />
            </button>
          </Tooltip>
        </span>
      </div>

      <div style={{ padding: "2px 10px 8px" }}>
        <Input
          size="small"
          allowClear
          placeholder="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ fontSize: 12 }}
        />
      </div>

      <div
        ref={rowsRef}
        role="tree"
        aria-label="Files"
        aria-multiselectable
        onKeyDown={handleKeyDown}
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 12 }}
      >
        {!treeStructure ? (
          <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : visibleTree ? (
          <TreeNode node={visibleTree} />
        ) : (
          <div
            style={{
              padding: "20px 14px",
              fontSize: 12,
              color: "var(--rc-text-subtle)",
              textAlign: "center",
            }}
          >
            No files match “{query.trim()}”
          </div>
        )}
      </div>

      <FileContextMenu />

      <NewEntryPrompt
        kind={creating}
        onCancel={() => setCreating(null)}
        onConfirm={handleCreate}
      />
    </div>
  );
};
