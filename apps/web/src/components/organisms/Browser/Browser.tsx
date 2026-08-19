import { useRef, useState } from "react";
import { Button, Flex, Input } from "antd";
import { ReloadOutlined, ExportOutlined } from "@ant-design/icons";

interface BrowserProps {
  projectId: string;
}

/** The preview is served by the backend's reverse proxy, NOT by a published
 *  container port. Containers expose nothing to the host, and this URL works
 *  from any machine that can reach the backend. */
function previewUrl(projectId: string): string {
  return `${import.meta.env.VITE_BACKEND_URL}/preview/${projectId}/`;
}

export const Browser = ({ projectId }: BrowserProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [cacheBust, setCacheBust] = useState(0);

  const src = previewUrl(projectId);

  function handleRefresh() {
    // Remounting via key is more reliable than poking .src on a cross-origin
    // iframe, whose contentWindow we cannot touch.
    setCacheBust((value) => value + 1);
  }

  return (
    <Flex vertical style={{ height: "100%", backgroundColor: "var(--rc-surface-raised)" }}>
      <Flex gap={6} style={{ padding: 6 }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={handleRefresh}
          title="Reload preview"
        />
        <Input
          size="small"
          value={src}
          readOnly
          style={{
            color: "var(--rc-text)",
            fontFamily: "var(--rc-mono)",
            fontSize: 12,
            backgroundColor: "var(--rc-surface)",
          }}
        />
        <Button
          size="small"
          icon={<ExportOutlined />}
          onClick={() => window.open(src, "_blank", "noopener")}
          title="Open in a new tab"
        />
      </Flex>

      <iframe
        key={cacheBust}
        ref={iframeRef}
        src={src}
        title="Project preview"
        style={{ flex: 1, width: "100%", border: "none", background: "white" }}
      />
    </Flex>
  );
};
