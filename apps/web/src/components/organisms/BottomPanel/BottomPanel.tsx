import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Tooltip } from "antd";
import { VscAdd, VscChromeClose, VscOutput, VscTerminal } from "react-icons/vsc";
import { BrowserTerminal } from "../../molecules/BrowserTerminal/BrowserTerminal.tsx";
import { RunOutput } from "../../molecules/RunOutput/RunOutput.tsx";
import { useRunStore } from "../../../store/runStore.ts";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../../../store/editorSocketStore.ts";

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
  const canEdit = useEditorSocketStore(selectCanEdit);

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

  /** The tabs were `button`s, which handled Enter and Space for free. They are
   *  `div`s now — a button cannot contain the close button — so the keys they
   *  used to get from the element have to be handled here, along with the
   *  arrows that make the strip one tab stop rather than one per shell. */
  function handleTabKeys(event: KeyboardEvent<HTMLDivElement>) {
    const strip = event.currentTarget;
    const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="tab"]',
    );
    if (!current) return;

    /** Selects whatever `data-rc-tab` names, so the keyboard and the click
     *  handlers cannot come to mean different things. */
    const select = (node: HTMLElement) => {
      const name = node.dataset["rcTab"];
      if (name === "output") setActive({ kind: "output" });
      else if (name?.startsWith("terminal:")) {
        setActive({ kind: "terminal", id: Number(name.slice("terminal:".length)) });
      }
    };

    const index = tabs.indexOf(current);
    let target: number | null = null;

    if (event.key === "ArrowRight") target = index + 1;
    else if (event.key === "ArrowLeft") target = index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(current);
      return;
    } else if (event.key === "Delete") {
      const name = current.dataset["rcTab"];
      // Output cannot be closed, and neither can a lone shell — closing it
      // would only immediately spawn a replacement.
      if (name?.startsWith("terminal:") && terminals.length > 1) {
        event.preventDefault();
        closeTerminal(Number(name.slice("terminal:".length)));
      }
      return;
    }

    // Clamped rather than wrapped, so holding an arrow rests at the end.
    if (target === null || target < 0 || target >= tabs.length) return;

    const next = tabs[target];
    if (!next) return;

    event.preventDefault();
    select(next);
    next.focus();
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
      {/* The shells and Output are one set — selecting either deselects the
          other — so they are one tablist. The "New shell" button sits inside it
          because that is where it belongs on screen, between the shells it adds
          to and the Output tab at the far end. */}
      <div
        role="tablist"
        aria-label="Panel"
        onKeyDown={handleTabKeys}
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
            // A div rather than a button: the close affordance below is itself
            // a button, and a button inside a button is invalid markup that
            // browsers resolve by dropping one of them.
            <div
              key={id}
              className="rc-panel-tab"
              role="tab"
              data-rc-tab={`terminal:${String(id)}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
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
                <button
                  type="button"
                  aria-label={`Close shell ${String(index + 1)}`}
                  className="rc-panel-tab-close"
                  // Out of the tab order: Delete on the tab closes it, which
                  // avoids a second stop per open shell.
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminal(id);
                  }}
                >
                  <VscChromeClose size={10} />
                </button>
              )}
            </div>
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

        <div
          className="rc-panel-tab"
          role="tab"
          data-rc-tab="output"
          aria-selected={active.kind === "output"}
          tabIndex={active.kind === "output" ? 0 : -1}
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
        </div>
      </div>

      {/* Hidden with display:none rather than unmounted -- see the note above. */}
      {canEdit ? (
        terminals.map((id) => (
          <Pane key={id} visible={active.kind === "terminal" && active.id === id}>
            <BrowserTerminal projectId={projectId} />
          </Pane>
        ))
      ) : (
        <Pane visible={active.kind === "terminal"}>
          <div
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              padding: 24,
              textAlign: "center",
              fontSize: 12.5,
              color: "var(--rc-text-subtle)",
            }}
          >
            {/* A shell can write anything the project can, so read-only access
                is not enough for one. Said here rather than letting the
                connection be refused with no explanation. */}
            You have read-only access to this project, so terminals are not
            available.
          </div>
        </Pane>
      )}

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
