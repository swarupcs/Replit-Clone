import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface BrowserTerminalProps {
  projectId: string;
  accessToken: string;
}

/** Terminal WebSocket endpoint.
 *
 *  Derived from VITE_BACKEND_URL rather than a hardcoded ws://localhost:4000,
 *  which could never work once the backend moved off the viewer's machine. The
 *  terminal now shares the main server's port.
 */
function terminalWsUrl(projectId: string): string {
  const backend = new URL(import.meta.env.VITE_BACKEND_URL);
  const protocol = backend.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${backend.host}/terminal?projectId=${encodeURIComponent(projectId)}`;
}

/** Owns its WebSocket rather than reading one from a store.
 *
 *  The socket used to be created by the page and handed over, so the shell's
 *  first output — the prompt — arrived before this component had registered a
 *  message listener. WebSocket messages are not queued, so that output was
 *  simply lost and the terminal rendered blank. Creating the socket here
 *  attaches the listener in the same tick.
 */
export const BrowserTerminal = ({ projectId, accessToken }: BrowserTerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !accessToken) return;

    const term = new Terminal({
      cursorBlink: true,
      // xterm paints to its own surface and cannot read CSS custom
      // properties, so these mirror the --rc-* tokens in index.css.
      theme: {
        background: "#0a0b12",
        foreground: "#e6e8f0",
        cursor: "#a78bfa",
        cursorAccent: "#0a0b12",
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
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      lineHeight: 1.35,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // The browser WebSocket API cannot set an Authorization header, and a token
    // in the query string lands in access logs, so it rides the subprotocol.
    let disposed = false;

    const socket = new WebSocket(terminalWsUrl(projectId), ["auth", accessToken]);
    socket.binaryType = "arraybuffer";

    /** fit() reads renderer cell dimensions that do not exist until the element
     *  is laid out; the first layout pass reports 0x0. */
    function syncSize() {
      // Every guard here matters: fit() and focus() both touch the renderer,
      // which throws "Cannot read properties of undefined (reading
      // 'dimensions')" once the Terminal has been disposed � and React 19's
      // StrictMode disposes one on every mount.
      if (disposed) return;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return; // Detached mid-resize; the next tick refits.
      }

      // Tell the container's PTY the new size. Without this the shell always
      // believed it had xterm's default 80x24, so full-screen TUIs and even
      // line wrapping were wrong.
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    syncSize();
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(container);

    const keyInput = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });

    socket.addEventListener("open", () => {
      if (disposed) return;
      syncSize();
      term.focus();
      // The shell prints its prompt the moment the exec starts, which can land
      // before this socket is attached. A bare newline makes bash redraw it, so
      // the terminal is never left looking dead.
      socket.send(String.fromCharCode(10));
    });

    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (disposed) return;
      const { data } = event;

      if (typeof data === "string") term.write(data);
      else if (data instanceof ArrayBuffer) term.write(new Uint8Array(data));
    });

    socket.addEventListener("close", (event) => {
      if (disposed) return;
      term.write(
        `\r\n\x1b[31mTerminal disconnected${event.reason ? `: ${event.reason}` : ""}.\x1b[0m\r\n`,
      );
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      keyInput.dispose();
      socket.close();
      term.dispose();
    };
  }, [projectId, accessToken]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        padding: "8px 10px",
        backgroundColor: "var(--rc-surface-sunken)",
        borderTop: "1px solid var(--rc-border)",
      }}
      id="terminal-container"
    />
  );
};
