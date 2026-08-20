import { useEffect, useMemo, useRef, useState } from "react";
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
  const { treeStructure, refreshTree, projectId, collapseAll, revealPath } =
    useTreeStructureStore();
  const { editorSocket } = useEditorSocketStore();

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

  const trimmedQuery = query.trim().toLowerCase();

  const visibleTree = useMemo(() => {
    if (!treeStructure) return null;
    if (!trimmedQuery) return treeStructure;
    return filterTree(treeStructure, trimmedQuery);
  }, [treeStructure, trimmedQuery]);

  // Filtering is useless against collapsed folders, so reveal every path that
  // survived the filter.
  useEffect(() => {
    if (!trimmedQuery || !visibleTree) return;
    folderPaths(visibleTree).forEach(revealPath);
  }, [trimmedQuery, visibleTree, revealPath]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshTree();
    } finally {
      setRefreshing(false);
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

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 12 }}>
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
