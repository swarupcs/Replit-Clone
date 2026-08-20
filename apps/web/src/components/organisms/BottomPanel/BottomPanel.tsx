import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { VscAdd, VscChromeClose, VscOutput, VscTerminal } from "react-icons/vsc";
import { BrowserTerminal } from "../../molecules/BrowserTerminal/BrowserTerminal.tsx";
import { RunOutput } from "../../molecules/RunOutput/RunOutput.tsx";
import { useRunStore } from "../../../store/runStore.ts";

interface BottomPanelProps {
  projectId: string;
}

/** `output` is the dev server log; every other tab is an independent shell. */
type ActiveTab = { kind: "output" } | { kind: "terminal"; id: number };

/** Terminals and dev-server output as tabs.
 *
 *  Multiple terminals matter because the dev server occupies one once it is
 *  running -- without a second shell you cannot `npm install` a package or run
 *  git without killing the server first. The backend already supported this:
 *  each /terminal socket opens its own `docker exec`, and container
 *  attachments are refcounted.
 *
 *  Every pane stays MOUNTED regardless of which is visible. A terminal owns a
 *  WebSocket and a PTY, so unmounting it to switch tabs would kill the shell
 *  and lose its scrollback.
 */
export const BottomPanel = ({ projectId }: BottomPanelProps) => {
  const [terminals, setTerminals] = useState<number[]>([1]);
  const [active, setActive] = useState<ActiveTab>({ kind: "terminal", id: 1 });
  /** Monotonic, so closing terminal 2 and opening another gives 3 rather than
   *  reusing an id whose React subtree was just torn down. */
  const nextId = useRef(2);

  const status = useRunStore((store) => store.state.status);

  // Pull attention to the output when a run starts, since that is where the
  // install/build progress and any failure will appear.
  useEffect(() => {
    if (status === "starting") setActive({ kind: "output" });
  }, [status]);

  function addTerminal() {
    const id = nextId.current;
    nextId.current += 1;
    setTerminals((current) => [...current, id]);
    setActive({ kind: "terminal", id });
  }

  function closeTerminal(id: number) {
    setTerminals((current) => {
      const remaining = current.filter((entry) => entry !== id);

      // Never leave the panel with no shell at all.
      if (remaining.length === 0) {
        const replacement = nextId.current;
        nextId.current += 1;
        setActive({ kind: "terminal", id: replacement });
        return [replacement];
      }

      setActive((currentActive) =>
        currentActive.kind === "terminal" && currentActive.id === id
          ? { kind: "terminal", id: remaining.at(-1) ?? remaining[0]! }
          : currentActive,
      );
      return remaining;
    });
  }

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
          alignItems: "center",
          flex: "none",
          borderBottom: "1px solid var(--rc-border)",
          overflowX: "auto",
        }}
      >
        {terminals.map((id, index) => {
          const selected = active.kind === "terminal" && active.id === id;

          return (
            <button
              key={id}
              className="rc-panel-tab"
              data-active={selected}
              onClick={() => setActive({ kind: "terminal", id })}
              onAuxClick={(event) => {
                if (event.button === 1) closeTerminal(id);
              }}
            >
              <VscTerminal size={13} />
              {/* Numbered by position, not id: after closing tabs the ids get
                  gappy and "Terminal 1, Terminal 4" reads as a bug. */}
              Shell {index + 1}

              {/* A lone terminal has no close button -- closing it would only
                  immediately spawn a replacement. */}
              {terminals.length > 1 && (
                <span
                  role="button"
                  aria-label={`Close shell ${String(index + 1)}`}
                  className="rc-panel-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminal(id);
                  }}
                >
                  <VscChromeClose size={10} />
                </span>
              )}
            </button>
          );
        })}

        <Tooltip title="New shell">
          <button
            className="rc-icon-button"
            style={{ margin: "0 6px", flex: "none" }}
            onClick={addTerminal}
            aria-label="New shell"
          >
            <VscAdd size={13} />
          </button>
        </Tooltip>

        <span style={{ flex: 1 }} />

        <button
          className="rc-panel-tab"
          data-active={active.kind === "output"}
          onClick={() => setActive({ kind: "output" })}
        >
          <VscOutput size={13} />
          Output
          {status === "running" && (
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
      </div>

      {/* Hidden with display:none rather than unmounted -- see the note above. */}
      {terminals.map((id) => (
        <Pane key={id} visible={active.kind === "terminal" && active.id === id}>
          <BrowserTerminal projectId={projectId} />
        </Pane>
      ))}

      <Pane visible={active.kind === "output"}>
        <RunOutput />
      </Pane>
    </div>
  );
};

const Pane = ({ visible, children }: { visible: boolean; children: ReactNode }) => (
  <div style={{ flex: 1, minHeight: 0, display: visible ? "block" : "none" }}>
    {children}
  </div>
);
