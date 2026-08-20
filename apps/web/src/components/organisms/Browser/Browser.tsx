import { useEffect, useRef, useState } from "react";
import { Button, Input, Segmented, Tooltip } from "antd";
import { ReloadOutlined, ExportOutlined } from "@ant-design/icons";
import { VscDeviceMobile, VscScreenFull, VscWindow } from "react-icons/vsc";

interface BrowserProps {
  projectId: string;
}

/** Viewport presets for responsive checks. `null` fills the pane. */
const DEVICES = [
  { value: "responsive", label: <VscScreenFull size={14} />, width: null, title: "Fill pane" },
  { value: "tablet", label: <VscWindow size={14} />, width: 768, title: "Tablet — 768px" },
  { value: "mobile", label: <VscDeviceMobile size={14} />, width: 390, title: "Mobile — 390px" },
] as const;

type DeviceValue = (typeof DEVICES)[number]["value"];

/** The preview is served by the backend's reverse proxy, NOT by a published
 *  container port. Containers expose nothing to the host, and this URL works
 *  from any machine that can reach the backend. */
function previewUrl(projectId: string): string {
  return `${import.meta.env.VITE_BACKEND_URL}/preview/${projectId}/`;
}

export const Browser = ({ projectId }: BrowserProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [cacheBust, setCacheBust] = useState(0);
  const [device, setDevice] = useState<DeviceValue>("responsive");
  const [loading, setLoading] = useState(true);

  const src = previewUrl(projectId);
  const width = DEVICES.find((d) => d.value === device)?.width ?? null;

  // Each remount starts a fresh load. The iframe is cross-origin, so `load` is
  // the only signal we get -- there is no way to observe a failed navigation.
  useEffect(() => {
    setLoading(true);
  }, [cacheBust]);

  function handleRefresh() {
    // Remounting via key is more reliable than poking .src on a cross-origin
    // iframe, whose contentWindow we cannot touch.
    setCacheBust((value) => value + 1);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-surface-raised)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: 8,
          borderBottom: "1px solid var(--rc-border)",
          background: "var(--rc-surface-sunken)",
        }}
      >
        <Tooltip title="Reload preview">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
          />
        </Tooltip>

        <Input
          size="small"
          value={src}
          readOnly
          prefix={
            <span
              aria-hidden
              title={loading ? "Loading" : "Loaded"}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                marginRight: 2,
                background: loading ? "var(--rc-yellow)" : "var(--rc-green)",
                animation: loading ? "rc-pulse 1.2s ease-in-out infinite" : undefined,
              }}
            />
          }
          style={{
            color: "var(--rc-text-muted)",
            fontFamily: "var(--rc-mono)",
            fontSize: 11.5,
          }}
        />

        <Segmented
          size="small"
          value={device}
          onChange={(value) => setDevice(value as DeviceValue)}
          options={DEVICES.map((d) => ({
            value: d.value,
            label: <Tooltip title={d.title}>{d.label}</Tooltip>,
          }))}
        />

        <Tooltip title="Open in a new tab">
          <Button
            size="small"
            type="text"
            icon={<ExportOutlined />}
            onClick={() => window.open(src, "_blank", "noopener")}
          />
        </Tooltip>
      </div>

      {/* Checkerboard ground so a transparent or short page is visibly the
          preview surface rather than an empty pane. */}
      <div
        className="rc-preview-stage"
        style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "start center" }}
      >
        <div
          style={{
            position: "relative",
            height: "100%",
            width: width ?? "100%",
            maxWidth: "100%",
            // A framed device gets a visible edge; the fill mode does not.
            boxShadow: width ? "0 0 0 1px var(--rc-border), var(--rc-shadow-lg)" : undefined,
            transition: "width 0.25s var(--rc-ease)",
          }}
        >
          {loading && <div className="rc-preview-progress" />}

          <iframe
            key={cacheBust}
            ref={iframeRef}
            src={src}
            title="Project preview"
            onLoad={() => setLoading(false)}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "white",
              display: "block",
            }}
          />
        </div>
      </div>
    </div>
  );
};
