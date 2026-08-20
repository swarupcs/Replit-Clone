import { useEffect, useState } from "react";
import { VscOutput, VscTerminal } from "react-icons/vsc";
import { BrowserTerminal } from "../../molecules/BrowserTerminal/BrowserTerminal.tsx";
import { RunOutput } from "../../molecules/RunOutput/RunOutput.tsx";
import { useRunStore } from "../../../store/runStore.ts";

interface BottomPanelProps {
  projectId: string;
  accessToken: string;
}

type PanelTab = "terminal" | "output";

/** Terminal and dev-server output, side by side as tabs.
 *
 *  Both stay MOUNTED regardless of which is visible: the terminal owns a
 *  WebSocket and a PTY, so unmounting it to switch tabs would kill the shell
 *  and lose scrollback.
 */
export const BottomPanel = ({ projectId, accessToken }: BottomPanelProps) => {
  const [tab, setTab] = useState<PanelTab>("terminal");
  const status = useRunStore((store) => store.state.status);

  // Pull attention to the output when a run starts, since that is where the
  // install/build progress and any failure will appear.
  useEffect(() => {
    if (status === "starting") setTab("output");
  }, [status]);

  const TABS: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
    { id: "terminal", label: "Terminal", icon: <VscTerminal size={13} /> },
    { id: "output", label: "Output", icon: <VscOutput size={13} /> },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-surface-sunken)",
        borderTop: "1px solid var(--rc-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          flex: "none",
          borderBottom: "1px solid var(--rc-border)",
        }}
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className="rc-panel-tab"
            data-active={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.icon}
            {entry.label}
            {entry.id === "output" && status === "running" && (
              <span
                aria-label="Dev server running"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--rc-green)",
                }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Kept mounted, hidden with display:none -- see the note above. */}
      <div style={{ flex: 1, minHeight: 0, display: tab === "terminal" ? "block" : "none" }}>
        <BrowserTerminal projectId={projectId} accessToken={accessToken} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === "output" ? "block" : "none" }}>
        <RunOutput />
      </div>
    </div>
  );
};
