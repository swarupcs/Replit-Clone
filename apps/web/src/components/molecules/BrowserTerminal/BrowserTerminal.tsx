import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AttachAddon } from "@xterm/addon-attach";
import "@xterm/xterm/css/xterm.css";
import { useTerminalSocketStore } from "../../../store/terminalSocketStore.ts";

export const BrowserTerminal = () => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const { terminalSocket } = useTerminalSocketStore();

  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#282a37",
        foreground: "#f8f8f3",
        cursor: "#f8f8f3",
        cursorAccent: "#282a37",
        red: "#ff5544",
        green: "#50fa7c",
        yellow: "#f1fa8c",
        cyan: "#8be9fd",
      },
      fontSize: 16,
      fontFamily: "Fira Code, monospace",
      convertEol: true,
    });

    term.open(container);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // fit() reads the renderer's cell dimensions, which do not exist until the
    // element has actually been laid out. Inside an Allotment pane the first
    // layout pass reports 0x0, so fitting unconditionally throws.
    function safeFit() {
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        // The element can be detached mid-resize; the next tick will refit.
      }
    }

    safeFit();

    // Keep the terminal sized to its Allotment pane instead of fitting once.
    const resizeObserver = new ResizeObserver(safeFit);
    resizeObserver.observe(container);

    function attach() {
      if (!terminalSocket) return;
      term.loadAddon(new AttachAddon(terminalSocket));
    }

    if (terminalSocket) {
      if (terminalSocket.readyState === WebSocket.OPEN) {
        attach();
      } else {
        terminalSocket.addEventListener("open", attach);
      }
    }

    return () => {
      resizeObserver.disconnect();
      terminalSocket?.removeEventListener("open", attach);
      term.dispose();
      // The socket is owned by ProjectPlayground; closing it here tore down the
      // connection on React 19's StrictMode double-mount.
    };
  }, [terminalSocket]);

  return (
    <div
      ref={terminalRef}
      style={{ width: "100%", height: "100%" }}
      className="terminal"
      id="terminal-container"
    />
  );
};
