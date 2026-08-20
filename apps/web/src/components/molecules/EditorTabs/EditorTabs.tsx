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

  if (tabs.length === 0) return null;

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
              if (event.button === 1) closeTab(tab.relPath);
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
                closeTab(tab.relPath);
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
    </div>
  );
};
