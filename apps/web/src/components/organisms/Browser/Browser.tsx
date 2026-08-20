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
      <Flex
        gap={6}
        align="center"
        style={{
          padding: 8,
          borderBottom: "1px solid var(--rc-border)",
          background: "var(--rc-surface-sunken)",
        }}
      >
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          onClick={handleRefresh}
          title="Reload preview"
        />
        <Input
          size="small"
          value={src}
          readOnly
          prefix={
            // Green dot: the preview is proxied over the backend, so if this
            // pane rendered at all the tunnel is up.
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "var(--rc-green)",
                marginRight: 2,
              }}
            />
          }
          style={{
            color: "var(--rc-text-muted)",
            fontFamily: "var(--rc-mono)",
            fontSize: 11.5,
          }}
        />
        <Button
          size="small"
          type="text"
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
