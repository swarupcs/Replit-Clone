import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Modal } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { VscSplitHorizontal } from "react-icons/vsc";
import { Tooltip } from "antd";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

/** The open-file tab strip.
 *
 *  The old EditorButton was an unused stub hardcoded to "file.js", and the
 *  editor could only ever hold one file.
 */
export const EditorTabs = () => {
  const { tabs, activeRelPath, secondaryRelPath, splitOpen, setActive, closeTab } =
    useOpenTabsStore();
  const openToSide = useOpenTabsStore((state) => state.openToSide);
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
          <div
            key={tab.relPath}
            className="rc-tab"
            role="tab"
            aria-selected={isActive}
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
            onDoubleClick={() => openToSide(tab.relPath)}
            title={tab.relPath}
          >
            <FileIcon extension={tab.extension} />
            <span>{tab.name}</span>

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
