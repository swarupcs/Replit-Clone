import { memo, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { IoIosArrowForward } from "react-icons/io";
import type { TreeNodeData } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon, FolderIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { markPreviewOpen } from "../../../lib/openIntent.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import {
  selectFileColors,
  usePresenceStore,
} from "../../../store/presenceStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import {
  selectOrderedSelection,
  useTreeSelectionStore,
} from "../../../store/treeSelectionStore.ts";

interface TreeNodeProps {
  node: TreeNodeData | null;
  depth?: number;
}

/** One row of the file tree, and its children.
 *
 *  Every subscription here is to a single value, and the component is memoised.
 *  Both matter because this renders once per file in the project: reading a
 *  whole store subscribes every row to every change in it, so opening a context
 *  menu, reporting an externally-changed file, or expanding any one folder
 *  re-rendered the entire tree. The stores whose actions are read
 *  (`toggleExpanded`, `open`, `click`) hand back stable references, so those
 *  subscriptions never fire at all.
 */
function TreeNodeRow({ node, depth = 0 }: TreeNodeProps) {
  const relPath = node?.relPath ?? null;

  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  const toggleExpanded = useTreeStructureStore((state) => state.toggleExpanded);
  const openContextMenu = useFileContextMenuStore((state) => state.open);
  /** Highlighted while something is being dragged over this row. */
  const [dropping, setDropping] = useState(false);
  const click = useTreeSelectionStore((state) => state.click);
  const isSelected = useTreeSelectionStore((state) =>
    relPath === null ? false : state.selected.has(relPath),
  );
  // Booleans about THIS row rather than the collections they come from. The
  // Set and the active path both change identity whenever anything in them
  // does, so subscribing to either would wake every row for one row's news.
  const isExpanded = useTreeStructureStore((state) =>
    // The root node is always expanded; it has no row of its own to click.
    relPath === "" || (relPath !== null && state.expandedPaths.has(relPath)),
  );
  const isActive = useOpenTabsStore((state) => state.activeRelPath === relPath);
  /** Whether THIS row is the tree's single tab stop.
   *
   *  A boolean rather than the focused path itself, so a row only re-renders
   *  when it gains or loses the tab stop — not every time focus moves anywhere
   *  in the tree. Before anything has been focused the first visible row holds
   *  it, so the tree is reachable from the keyboard on a fresh page. */
  const isTabStop = useTreeSelectionStore((state) =>
    relPath === null
      ? false
      : state.focused === null
        ? state.visibleOrder[0] === relPath
        : state.focused === relPath,
  );
  const setFocused = useTreeSelectionStore((state) => state.setFocused);
  /** Who else is in this file, as a comma-joined list of their colours.
   *
   *  A string, so a row re-renders only when the people in ITS file change —
   *  an array would hand every row a new identity on every awareness update
   *  and wake the whole tree. */
  const presence = usePresenceStore(selectFileColors(relPath ?? ""));

  if (!node) return null;

  const isFolder = node.type === "directory";

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!node) return;

    // Right-clicking outside the selection acts on that row alone, the way
    // every file manager behaves; inside it, the selection is kept.
    const selection = useTreeSelectionStore.getState();
    if (!selection.selected.has(node.relPath)) {
      selection.selectOnly(node.relPath);
    }

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

    // Dragging a selected row moves the whole selection; dragging an unselected
    // one moves only it.
    const selection = useTreeSelectionStore.getState();
    const moving = selection.selected.has(source)
      ? selectOrderedSelection(selection)
      : [source];

    for (const relPath of moving) {
      // Skip anything already in the destination, and never drop a folder into
      // itself or into one of its own descendants.
      const currentDir = relPath.split("/").slice(0, -1).join("/");
      if (currentDir === destDir) continue;
      if (destDir === relPath || destDir.startsWith(`${relPath}/`)) continue;

      editorSocket?.emit("moveEntry", { relPath, destDir });
    }
  }

  return (
    <div>
      {node.relPath !== "" && (
        <div
          className="rc-tree-row"
          // Read by the tree's keyboard handler, which navigates by walking
          // these off the DOM rather than by re-deriving the tree — the row it
          // needs to know about is always the one that has focus.
          data-rc-path={node.relPath}
          data-rc-kind={node.type}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={isSelected}
          {...(isFolder ? { "aria-expanded": isExpanded } : {})}
          tabIndex={isTabStop ? 0 : -1}
          onFocus={() => setFocused(node.relPath)}
          data-active={isActive}
          data-selected={isSelected}
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
          onClick={(event) => {
            const meta = event.metaKey || event.ctrlKey;
            click(node.relPath, { meta, shift: event.shiftKey });

            // A modified click is selecting, not navigating.
            if (meta || event.shiftKey) return;

            if (isFolder) {
              toggleExpanded(node.relPath);
            } else {
              // Single click opens, matching every real editor. It used to
              // require a double click. It opens as a preview: browsing a
              // tree a file at a time otherwise leaves a tab behind for every
              // file looked at and discarded.
              markPreviewOpen(node.relPath);
              editorSocket?.emit("readFile", { relPath: node.relPath });
            }
          }}
          onDoubleClick={() => {
            // Double-clicking a file in the tree keeps it, the same gesture
            // that keeps it from the tab strip. Folders already toggle on the
            // first click, so the second would only close what the first
            // opened.
            if (!isFolder) useOpenTabsStore.getState().promoteTab(node.relPath);
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
              <FolderIcon name={node.name} open={isExpanded} />
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

          {presence && (
            // One dot per person, in their own colour: the same colour their
            // cursor already has inside the file.
            <span
              aria-label="Someone else is in this file"
              style={{ display: "flex", gap: 2, marginLeft: "auto", flex: "none" }}
            >
              {presence.split(",").map((color, index) => (
                <span
                  key={index}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: color,
                  }}
                />
              ))}
            </span>
          )}
        </div>
      )}

      {isFolder && isExpanded && node.children && node.children.length > 0 && (
        // Indent guide: a hairline at this level's depth, so a deeply nested
        // file can be traced back to its folder.
        <div
          role="group"
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
}

/** Memoised so a parent's re-render does not cascade.
 *
 *  `node` comes from the tree in the store and keeps its identity between
 *  refetches that did not change it, so expanding one folder re-renders that
 *  folder and mounts its children — and leaves every other row alone. */
export const TreeNode = memo(TreeNodeRow);
