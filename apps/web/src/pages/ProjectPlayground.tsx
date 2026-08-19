import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Button } from "antd";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { EditorComponent } from "../components/molecules/EditorComponent/EditorComponent.tsx";
import { BrowserTerminal } from "../components/molecules/BrowserTerminal/BrowserTerminal.tsx";
import { TreeStructure } from "../components/organisms/TreeStructure/TreeStructure.tsx";
import { Browser } from "../components/organisms/Browser/Browser.tsx";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../store/editorSocketStore.ts";
import { useTerminalSocketStore } from "../store/terminalSocketStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

/** Terminal websocket endpoint.
 *
 *  Defaults to the backend host rather than a hardcoded ws://localhost:4000,
 *  which could never work once the backend moved off the viewer's machine.
 *  Phase 2 folds this into the main server so the separate port disappears.
 */
function terminalWsUrl(projectId: string): string {
  const explicit = import.meta.env.VITE_TERMINAL_WS_URL;
  const base =
    explicit ??
    (() => {
      const backend = new URL(import.meta.env.VITE_BACKEND_URL);
      const wsProtocol = backend.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProtocol}//${backend.hostname}:4000`;
    })();

  return `${base}/terminal?projectId=${encodeURIComponent(projectId)}`;
}

export const ProjectPlayground = () => {
  const { projectId: projectIdFromUrl } = useParams<{ projectId: string }>();

  const { setProjectId, projectId } = useTreeStructureStore();
  const { setEditorSocket } = useEditorSocketStore();
  const { terminalSocket, setTerminalSocket } = useTerminalSocketStore();

  const [loadBrowser, setLoadBrowser] = useState(false);

  useEffect(() => {
    if (!projectIdFromUrl) return;

    setProjectId(projectIdFromUrl);

    const editorSocketConn: EditorSocket = io(
      `${import.meta.env.VITE_BACKEND_URL}/editor`,
      { query: { projectId: projectIdFromUrl } },
    );
    setEditorSocket(editorSocketConn);

    const ws = new WebSocket(terminalWsUrl(projectIdFromUrl));
    setTerminalSocket(ws);

    // Both sockets are owned here, so they are torn down here too.
    return () => {
      editorSocketConn.disconnect();
      setEditorSocket(null);
      ws.close();
      setTerminalSocket(null);
    };
  }, [setProjectId, projectIdFromUrl, setEditorSocket, setTerminalSocket]);

  return (
    <div style={{ display: "flex" }}>
      {projectId && (
        <div
          style={{
            backgroundColor: "#333254",
            paddingRight: "10px",
            paddingTop: "0.3vh",
            minWidth: "250px",
            maxWidth: "25%",
            height: "100vh",
            overflow: "auto",
          }}
        >
          <TreeStructure />
        </div>
      )}

      <div style={{ width: "100vw", height: "100vh" }}>
        <Allotment>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "100%",
              height: "100%",
              backgroundColor: "#282a36",
            }}
          >
            <Allotment vertical>
              <EditorComponent />
              <BrowserTerminal />
            </Allotment>
          </div>

          <div>
            <Button onClick={() => setLoadBrowser(true)}>Load my browser</Button>
            {loadBrowser && projectIdFromUrl && terminalSocket && (
              <Browser projectId={projectIdFromUrl} />
            )}
          </div>
        </Allotment>
      </div>
    </div>
  );
};
