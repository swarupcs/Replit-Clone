import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Dropdown, Modal } from "antd";
import type { MenuProps } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { VscPinned, VscSplitHorizontal } from "react-icons/vsc";
import { Tooltip } from "antd";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { usePresenceStore } from "../../../store/presenceStore.ts";

/** The open-file tab strip.
 *
 *  The old EditorButton was an unused stub hardcoded to "file.js", and the
 *  editor could only ever hold one file.
 */
export const EditorTabs = () => {
  const { tabs, activeRelPath, secondaryRelPath, splitOpen, setActive, closeTab } =
    useOpenTabsStore();
  const openToSide = useOpenTabsStore((state) => state.openToSide);
  const promoteTab = useOpenTabsStore((state) => state.promoteTab);
  const togglePin = useOpenTabsStore((state) => state.togglePin);
  const moveTab = useOpenTabsStore((state) => state.moveTab);
  const closeOthers = useOpenTabsStore((state) => state.closeOthers);
  const closeToRight = useOpenTabsStore((state) => state.closeToRight);
  const closeSaved = useOpenTabsStore((state) => state.closeSaved);
  /** The whole map: the strip holds a handful of tabs, so one subscription for
   *  the lot is cheaper than one per tab. */
  const colorsByFile = usePresenceStore((state) => state.colorsByFile);
  const closeSplit = useOpenTabsStore((state) => state.closeSplit);

  /** A tab whose close is waiting on confirmation, because it still has edits
   *  that have not reached the server. */
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Closing a clean tab is free; closing a dirty one throws away work that
   *  exists nowhere else, so it asks first. */
  function requestClose(relPath: string) {
    const tab = tabs.find((entry) => entry.relPath === relPath);
    if (tab?.isDirty) {
      setConfirming(relPath);
      return;
    }
    closeTab(relPath);
  }

  /** The strip, so a key press can move focus to a sibling tab. */
  const stripRef = useRef<HTMLDivElement>(null);

  /** The tab being dragged, if any. Held in a ref rather than state: it
   *  changes on every dragover and nothing renders from it. */
  const dragging = useRef<string | null>(null);

  /** The per-tab context menu. Built per tab because three of its five items
   *  are about that tab's position in the strip rather than about the strip. */
  function menuFor(relPath: string, isPinned: boolean): MenuProps["items"] {
    return [
      {
        key: "pin",
        label: isPinned ? "Unpin" : "Pin",
        onClick: () => togglePin(relPath),
      },
      { type: "divider" },
      {
        key: "others",
        label: "Close others",
        onClick: () => closeOthers(relPath),
      },
      {
        key: "right",
        label: "Close to the right",
        onClick: () => closeToRight(relPath),
      },
      {
        key: "saved",
        label: "Close saved",
        onClick: () => closeSaved(),
      },
    ];
  }

  /** Arrow keys walk the strip and switch as they go — `role="tab"` sets the
   *  expectation that moving to a tab selects it, and every tab here is
   *  already open, so switching costs nothing. Delete closes, which is the one
   *  gesture a keyboard user otherwise had no way to reach: the close button
   *  was a `span` with a click handler. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.relPath === activeRelPath);
    if (index === -1) return;

    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    let target: number | null = null;
    if (step !== 0) target = index + step;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    else if (event.key === "Delete") {
      event.preventDefault();
      requestClose(tabs[index]?.relPath ?? "");
      return;
    }

    // Clamped rather than wrapped, so holding an arrow rests at the end of the
    // strip instead of cycling.
    if (target === null || target < 0 || target >= tabs.length) return;

    const next = tabs[target];
    if (!next) return;

    event.preventDefault();
    setActive(next.relPath);

    // Focus follows selection, otherwise the next arrow key would still be
    // measured from the tab the user has visibly left.
    const nodes = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    nodes?.[target]?.focus();
  }

  if (tabs.length === 0) return null;

  const confirmingName = confirming?.split("/").pop() ?? "";

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open files"
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        overflowX: "auto",
        backgroundColor: "var(--rc-surface-sunken)",
        borderBottom: "1px solid var(--rc-border)",
        flex: "0 0 auto",
      }}
    >
      {tabs.map((tab) => {
        // A tab reads as current when either pane is showing it.
        const isActive =
          tab.relPath === activeRelPath ||
          (splitOpen && tab.relPath === secondaryRelPath);

        return (
          <Dropdown
            key={tab.relPath}
            trigger={["contextMenu"]}
            menu={{ items: menuFor(tab.relPath, tab.isPinned) }}
          >
          <div
            className="rc-tab"
            role="tab"
            aria-selected={isActive}
            data-preview={tab.isPreview}
            draggable
            onDragStart={() => {
              dragging.current = tab.relPath;
            }}
            onDragOver={(event) => {
              // Without this the drop never fires: the default handling of
              // dragover is to refuse the drop.
              if (dragging.current && dragging.current !== tab.relPath) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragging.current;
              dragging.current = null;
              if (!from || from === tab.relPath) return;
              moveTab(from, tabs.findIndex((entry) => entry.relPath === tab.relPath));
            }}
            onDragEnd={() => {
              dragging.current = null;
            }}
            // One tab stop for the whole strip: Tab reaches the current file
            // and the arrows move within it, rather than Tab walking through
            // every open file to get past the strip.
            tabIndex={tab.relPath === activeRelPath ? 0 : -1}
            data-active={isActive}
            onClick={() => setActive(tab.relPath)}
            onAuxClick={(event) => {
              // Middle click closes, as in every editor.
              if (event.button === 1) requestClose(tab.relPath);
            }}
            // Double click keeps a preview tab, which is what VS Code does
            // and what makes single-click browsing safe: the strip does not
            // fill up, and anything worth keeping is one gesture away. The
            // split gesture moved to the button at the end of the strip,
            // which was already there and says what it does.
            onDoubleClick={() => promoteTab(tab.relPath)}
            title={tab.relPath}
          >
            <FileIcon extension={tab.extension} name={tab.name} />
            <span style={{ fontStyle: tab.isPreview ? "italic" : undefined }}>
              {tab.name}
            </span>

            {tab.isPinned && (
              <VscPinned
                size={11}
                aria-label="Pinned"
                style={{ flex: "none", opacity: 0.7 }}
              />
            )}

            {colorsByFile[tab.relPath] && (
              <span
                aria-label="Someone else is in this file"
                style={{ display: "flex", gap: 2, flex: "none" }}
              >
                {colorsByFile[tab.relPath]?.split(",").map((color, index) => (
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

            {/* A real button: it was a `span`, so closing a file was a
                mouse-only gesture and screen readers were told nothing about
                it. Kept out of the tab order — Delete on the tab does this
                without adding a second stop per open file. */}
            <button
              type="button"
              className="rc-tab-close"
              tabIndex={-1}
              aria-label={`Close ${tab.name}`}
              data-dirty={tab.isDirty}
              onClick={(event) => {
                event.stopPropagation();
                requestClose(tab.relPath);
              }}
            >
              {tab.isDirty ? (
                // An unsaved-changes dot, replaced by the close affordance.
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    backgroundColor: "var(--rc-accent)",
                  }}
                />
              ) : (
                <CloseOutlined style={{ fontSize: 10 }} />
              )}
            </button>
          </div>
          </Dropdown>
        );
      })}

      <span style={{ flex: 1 }} />

      {/* Monaco handles two editors over one model, so a file can be open in
          both panes and stay in step. Double-clicking a tab does the same. */}
      <Tooltip title={splitOpen ? "Close the second pane" : "Split the editor"}>
        <button
          className="rc-icon-button"
          style={{ margin: "0 6px", flex: "none" }}
          data-on={splitOpen}
          aria-label={splitOpen ? "Close the second pane" : "Split the editor"}
          onClick={() => {
            if (splitOpen) closeSplit();
            else if (activeRelPath) openToSide(activeRelPath);
          }}
          disabled={!activeRelPath && !splitOpen}
        >
          <VscSplitHorizontal size={14} />
        </button>
      </Tooltip>

      <Modal
        open={confirming !== null}
        title="Discard unsaved changes?"
        okText="Discard"
        okButtonProps={{ danger: true }}
        cancelText="Keep editing"
        onOk={() => {
          if (confirming) closeTab(confirming);
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
        destroyOnHidden
      >
        <span style={{ color: "var(--rc-text-muted)" }}>
          <b>{confirmingName}</b> has edits that have not been saved yet.
          Closing it now loses them.
        </span>
      </Modal>
    </div>
  );
};
