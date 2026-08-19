import { useEffect, useRef } from "react";
import { Input, Row } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { usePortStore } from "../../../store/portStore.ts";

interface BrowserProps {
  projectId: string;
}

/** Host the project's dev server is published on.
 *
 *  Derived from VITE_BACKEND_URL so this keeps working when the backend is on
 *  the VM rather than the viewer's machine. Phase 2 replaces the whole
 *  published-port scheme with a `/preview/:projectId/` reverse proxy.
 */
function previewOrigin(port: string): string {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  const host = backendUrl ? new URL(backendUrl).hostname : window.location.hostname;
  return `http://${host}:${port}`;
}

export const Browser = ({ projectId }: BrowserProps) => {
  const browserRef = useRef<HTMLIFrameElement>(null);
  const { port } = usePortStore();
  const { editorSocket } = useEditorSocketStore();

  useEffect(() => {
    if (!port) {
      editorSocket?.emit("getPort", { containerName: projectId });
    }
  }, [port, editorSocket, projectId]);

  if (!port) {
    return <div>Loading....</div>;
  }

  const src = previewOrigin(port);

  function handleRefresh() {
    const iframe = browserRef.current;
    if (!iframe) return;
    // Re-setting the src attribute forces a reload; the iframe is cross-origin
    // so contentWindow.location.reload() is not available to us.
    const current = iframe.src;
    iframe.src = "about:blank";
    iframe.src = current;
  }

  return (
    <Row style={{ backgroundColor: "#22212b" }}>
      <Input
        style={{
          width: "100%",
          height: "30px",
          color: "white",
          fontFamily: "Fira Code, monospace",
          backgroundColor: "#282a35",
        }}
        prefix={<ReloadOutlined onClick={handleRefresh} />}
        value={src}
        readOnly
      />

      <iframe
        ref={browserRef}
        src={src}
        title="Project preview"
        style={{ width: "100%", height: "95vh", border: "none" }}
      />
    </Row>
  );
};
