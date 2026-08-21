import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Tooltip } from "antd";
import { useAuthStore } from "../../../store/authStore.ts";
import { refreshAccessToken } from "../../../config/axiosConfig.ts";
import { VscClearAll, VscDebugRestart } from "react-icons/vsc";
import "@xterm/xterm/css/xterm.css";

interface BrowserTerminalProps {
  projectId: string;
}

type ConnectionState = "connecting" | "open" | "closed";

const STATUS_COPY: Record<ConnectionState, { label: string; color: string }> = {
  connecting: { label: "Connecting", color: "var(--rc-yellow)" },
  open: { label: "Connected", color: "var(--rc-green)" },
  closed: { label: "Disconnected", color: "var(--rc-red)" },
};

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
export const BrowserTerminal = ({ projectId }: BrowserTerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  /** Whether a session exists at all — NOT its token.
   *
   *  This flips false to true once, when the boot-time refresh settles, and
   *  then stays true across every rotation. Depending on it reconnects a
   *  terminal that mounted before the session was ready, without reconnecting
   *  one every time the token behind it changes. */
  const hasSession = useAuthStore((state) => state.accessToken !== null);

  const [status, setStatus] = useState<ConnectionState>("connecting");
  /** Bumping this tears the effect down and builds a fresh socket + terminal,
   *  which is what "reconnect" means here. */
  const [reconnectNonce, setReconnectNonce] = useState(0);

  /** Backoff state for automatic reconnection, kept in refs so it survives the
   *  effect re-running (which is how a reconnect happens). A dropped socket --
   *  the server restarting, a network blip, a rotated-out token -- used to
   *  leave the terminal dead until the user clicked reconnect by hand. */
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Read imperatively, and deliberately NOT a dependency. The access token
    // rotates roughly every fifteen minutes, and having it in the dependency
    // array tore down every shell each time it did: scrollback, working
    // directory, shell history and any foreground process all went with it.
    // Only the handshake needs a live token; the socket survives on its own
    // afterwards.
    const accessToken = useAuthStore.getState().accessToken;
    if (!accessToken) return;

    setStatus("connecting");

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
      scrollback: 5000,
      // Padding lives on the wrapper, not the canvas, so the cursor never sits
      // flush against the edge.
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;

    // The browser WebSocket API cannot set an Authorization header, and a token
    // in the query string lands in access logs, so it rides the subprotocol.
    let disposed = false;
    // Whether this socket ever reached OPEN. A close before it did points at a
    // rejected handshake (usually a stale token) rather than a dropped
    // connection, and the two want different recovery.
    let opened = false;

    const socket = new WebSocket(terminalWsUrl(projectId), ["auth", accessToken]);
    socket.binaryType = "arraybuffer";

    /** fit() reads renderer cell dimensions that do not exist until the element
     *  is laid out; the first layout pass reports 0x0. */
    function syncSize() {
      // Every guard here matters: fit() and focus() both touch the renderer,
      // which throws "Cannot read properties of undefined (reading
      // 'dimensions')" once the Terminal has been disposed -- and React 19's
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
      // A healthy connection clears the backoff, so the next unexpected drop
      // starts retrying promptly instead of at the tail of an old backoff.
      opened = true;
      retriesRef.current = 0;
      setStatus("open");
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
      setStatus("closed");

      const MAX_RETRIES = 6;
      if (retriesRef.current >= MAX_RETRIES) {
        term.write(
          `\r\n\x1b[31mTerminal disconnected${event.reason ? `: ${event.reason}` : ""}. Click reconnect to try again.\x1b[0m\r\n`,
        );
        return;
      }

      const attempt = retriesRef.current;
      retriesRef.current += 1;
      // 0.5s, 1s, 2s, 4s, 8s, capped at 10s.
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      term.write(
        `\r\n\x1b[33mTerminal disconnected${event.reason ? `: ${event.reason}` : ""}. Reconnecting…\x1b[0m\r\n`,
      );

      reconnectTimerRef.current = window.setTimeout(() => {
        void (async () => {
          if (disposed) return;
          // A close before OPEN is almost always a rejected handshake -- the
          // stored access token was missing or expired. REST refreshes itself
          // on a 401, but a WebSocket cannot, so do it here before retrying,
          // otherwise every attempt presents the same dead token. Routed
          // through the shared, de-duplicated refresher so this never races a
          // REST refresh: refresh tokens are single-use and a reused one
          // revokes the whole session. Best-effort -- if refresh fails the
          // retry still runs and simply closes again.
          if (!opened) {
            try {
              await refreshAccessToken();
            } catch {
              // No live session to refresh; the retry will surface that.
            }
          }
          if (!disposed) setReconnectNonce((value) => value + 1);
        })();
      }, delay);
    });

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      resizeObserver.disconnect();
      keyInput.dispose();
      socket.close();
      term.dispose();
      termRef.current = null;
    };
  }, [projectId, hasSession, reconnectNonce]);

  const handleClear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  const handleReconnect = useCallback(() => {
    // A manual reconnect is a fresh start: clear the backoff so it does not
    // inherit a long delay from a prior run of failures.
    retriesRef.current = 0;
    setReconnectNonce((value) => value + 1);
  }, []);

  const statusInfo = STATUS_COPY[status];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-surface-sunken)",
      }}
    >
      <div className="rc-pane-label" style={{ justifyContent: "space-between" }}>
        {/* The panel tab already names this pane, so the header carries only
            state and actions. */}
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            title={statusInfo.label}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: statusInfo.color,
              // A steady dot once connected; pulsing while it is still trying.
              animation:
                status === "connecting" ? "rc-pulse 1.2s ease-in-out infinite" : undefined,
            }}
          />
          <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>
            {statusInfo.label}
          </span>
        </span>

        <span style={{ display: "flex", gap: 2 }}>
          <Tooltip title="Clear">
            <button className="rc-icon-button" onClick={handleClear} aria-label="Clear">
              <VscClearAll size={14} />
            </button>
          </Tooltip>
          <Tooltip title="Reconnect">
            <button
              className="rc-icon-button"
              onClick={handleReconnect}
              aria-label="Reconnect"
            >
              <VscDebugRestart size={14} />
            </button>
          </Tooltip>
        </span>
      </div>

      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, padding: "4px 10px 8px" }}
        id="terminal-container"
      />
    </div>
  );
};
