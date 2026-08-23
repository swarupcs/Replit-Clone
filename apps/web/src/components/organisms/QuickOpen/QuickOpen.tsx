import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Input } from "antd";
import type { InputRef } from "antd";
import type { TreeNodeData } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { fuzzyScore } from "../../../utils/fuzzyScore.ts";

interface QuickOpenProps {
  open: boolean;
  onClose: () => void;
}

interface FileEntry {
  relPath: string;
  name: string;
}

/** Flattens the tree to files only — folders are not openable. */
function collectFiles(node: TreeNodeData | null, into: FileEntry[] = []): FileEntry[] {
  if (!node) return into;

  if (node.type === "directory") {
    node.children?.forEach((child) => collectFiles(child, into));
  } else if (node.relPath) {
    into.push({ relPath: node.relPath, name: node.name });
  }
  return into;
}

const MAX_RESULTS = 50;

/** Ctrl/Cmd+P file switcher.
 *
 *  Reaching a file previously meant expanding it in the tree by hand, which is
 *  slow in any project more than a couple of folders deep.
 */
export const QuickOpen = ({ open, onClose }: QuickOpenProps) => {
  const treeStructure = useTreeStructureStore((store) => store.treeStructure);
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const files = useMemo(() => collectFiles(treeStructure), [treeStructure]);

  const results = useMemo(() => {
    const scored: { entry: FileEntry; score: number }[] = [];

    for (const entry of files) {
      const score = fuzzyScore(entry.relPath, query.trim());
      if (score !== null) scored.push({ entry, score });
    }

    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, MAX_RESULTS).map((item) => item.entry);
  }, [files, query]);

  // Reset per opening, so the palette never reopens showing a stale query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlighted(0);
    }
  }, [open]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(highlighted)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  function openFile(entry: FileEntry | undefined) {
    if (!entry) return;
    editorSocket?.emit("readFile", { relPath: entry.relPath });
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openFile(results[highlighted]);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      destroyOnHidden
      width={560}
      // Sits high like every editor's palette rather than centred.
      style={{ top: 90 }}
      styles={{ body: { padding: 0 } }}
      afterOpenChange={(isOpen) => {
        if (isOpen) inputRef.current?.focus();
      }}
    >
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        placeholder="Go to file…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        style={{ fontSize: 15, padding: "12px 16px" }}
      />

      <div
        ref={listRef}
        style={{
          maxHeight: 340,
          overflowY: "auto",
          borderTop: "1px solid var(--rc-border)",
          padding: 6,
        }}
      >
        {results.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--rc-text-subtle)",
            }}
          >
            {files.length === 0 ? "Loading files…" : "No matching files"}
          </div>
        ) : (
          results.map((entry, index) => {
            const directory = entry.relPath.split("/").slice(0, -1).join("/");

            return (
              <div
                key={entry.relPath}
                data-index={index}
                className="rc-quickopen-row"
                data-highlighted={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => openFile(entry)}
              >
                <FileIcon extension={fileExtension(entry.name)} name={entry.name} />
                <span style={{ fontWeight: 500 }}>{entry.name}</span>
                {directory && (
                  <span
                    style={{
                      color: "var(--rc-text-subtle)",
                      fontSize: 11.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {directory}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
};
