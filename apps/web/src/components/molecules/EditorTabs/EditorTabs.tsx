import { useState } from "react";
import { Modal } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

/** The open-file tab strip.
 *
 *  The old EditorButton was an unused stub hardcoded to "file.js", and the
 *  editor could only ever hold one file.
 */
export const EditorTabs = () => {
  const { tabs, activeRelPath, setActive, closeTab } = useOpenTabsStore();

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

  if (tabs.length === 0) return null;

  const confirmingName = confirming?.split("/").pop() ?? "";

  return (
    <div
      style={{
        display: "flex",
        overflowX: "auto",
        backgroundColor: "var(--rc-surface-sunken)",
        borderBottom: "1px solid var(--rc-border)",
        flex: "0 0 auto",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.relPath === activeRelPath;

        return (
          <div
            key={tab.relPath}
            className="rc-tab"
            data-active={isActive}
            onClick={() => setActive(tab.relPath)}
            onAuxClick={(event) => {
              // Middle click closes, as in every editor.
              if (event.button === 1) requestClose(tab.relPath);
            }}
            title={tab.relPath}
          >
            <FileIcon extension={tab.extension} />
            <span>{tab.name}</span>

            <span
              className="rc-tab-close"
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
            </span>
          </div>
        );
      })}

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
