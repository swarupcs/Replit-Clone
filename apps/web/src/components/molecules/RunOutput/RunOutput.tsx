import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Tooltip } from "antd";
import { VscClearAll } from "react-icons/vsc";
import { useRunStore } from "../../../store/runStore.ts";
import "@xterm/xterm/css/xterm.css";

/** Read-only view of the dev server's output.
 *
 *  Rendered with xterm rather than a <pre> because build tools emit ANSI colour
 *  and carriage-return progress bars, which plain text renders as unreadable
 *  garbage.
 */
export const RunOutput = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** How many chunks have been written, so re-renders append rather than
   *  rewriting the whole buffer. */
  const writtenRef = useRef(0);

  const output = useRunStore((store) => store.output);
  const status = useRunStore((store) => store.state.status);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      // No input is forwarded anywhere, so a cursor would be misleading.
      disableStdin: true,
      cursorStyle: "bar",
      cursorBlink: false,
      theme: {
        background: "#0a0b12",
        foreground: "#e6e8f0",
        selectionBackground: "#2a2e42",
        black: "#0a0b12",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#a78bfa",
        cyan: "#22d3ee",
        white: "#e6e8f0",
        brightBlack: "#6b7192",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#c4b5fd",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
      fontSize: 12.5,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;
    writtenRef.current = 0;

    function fit() {
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        // Detached mid-resize; the next tick refits.
      }
    }

    fit();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Append only what is new. Rewriting the whole buffer on every chunk would
  // reset the user's scroll position on every frame of a progress bar.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (output.length < writtenRef.current) {
      // History was replaced (reconnect) or cleared: start over.
      term.clear();
      writtenRef.current = 0;
    }

    for (let i = writtenRef.current; i < output.length; i += 1) {
      term.write(output[i] ?? "");
    }
    writtenRef.current = output.length;
  }, [output]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-surface-sunken)",
      }}
    >
      {/* The panel tab already names this pane. */}
      <div className="rc-pane-label" style={{ justifyContent: "flex-end" }}>
        <Tooltip title="Clear">
          <button
            className="rc-icon-button"
            aria-label="Clear output"
            onClick={() => {
              termRef.current?.clear();
            }}
          >
            <VscClearAll size={14} />
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: "4px 10px 8px", position: "relative" }}>
        {output.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 12.5,
              color: "var(--rc-text-subtle)",
              pointerEvents: "none",
            }}
          >
            {status === "idle"
              ? "Press Run to start the dev server."
              : "Waiting for output…"}
          </div>
        )}
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
};
