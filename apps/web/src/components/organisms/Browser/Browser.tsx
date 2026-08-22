import { useEffect, useRef, useState } from "react";
import { Button, Input, Segmented, Select, Tooltip } from "antd";
import { ReloadOutlined, ExportOutlined } from "@ant-design/icons";
import { VscDeviceMobile, VscScreenFull, VscWindow } from "react-icons/vsc";
import { useQuery } from "@tanstack/react-query";
import { useRunStore } from "../../../store/runStore.ts";
import { getProjectPorts } from "../../../apis/projects.ts";

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

/** Origin serving project previews.
 *
 *  Defaults to the API's own, which is the simplest deployment and the least
 *  safe one: a project's code — including any dependency it installs — then
 *  runs on the same origin as the API, where it can POST to
 *  /api/v1/auth/refresh with the session cookie and mint itself a working
 *  access token. Neither CORS nor SameSite applies to a same-origin request.
 *
 *  Pointing this at a separate host closes that off at the origin boundary,
 *  and is what lets the iframe below afford `allow-same-origin`.
 */
const PREVIEW_ORIGIN =
  import.meta.env.VITE_PREVIEW_ORIGIN ?? import.meta.env.VITE_BACKEND_URL;

/** True when previews cannot reach the API as a same-origin caller. */
function isIsolatedFromApi(): boolean {
  try {
    return (
      new URL(PREVIEW_ORIGIN).origin !==
      new URL(import.meta.env.VITE_BACKEND_URL).origin
    );
  } catch {
    // An unparseable override is not evidence of isolation.
    return false;
  }
}

/** Capabilities granted to the framed project.
 *
 *  Without `allow-same-origin` the document gets an opaque origin, so it cannot
 *  read the session cookie or make credentialed calls to the API however the
 *  URLs line up. The cost is that the project's own app loses localStorage,
 *  cookies and IndexedDB — so a deployment that isolates previews on their own
 *  host gets those back, having removed the reason to withhold them.
 */
const SANDBOX = [
  "allow-scripts",
  "allow-forms",
  "allow-popups",
  "allow-modals",
  ...(isIsolatedFromApi() ? ["allow-same-origin"] : []),
].join(" ");

/** The preview is served by the backend's reverse proxy, NOT by a published
 *  container port. Containers expose nothing to the host, and this URL works
 *  from any machine that can reach the backend. */
function previewUrl(projectId: string, port?: number): string {
  const base = `${PREVIEW_ORIGIN}/preview/${projectId}/`;
  // Omitted for the template's own dev port, so the common case keeps a clean
  // URL and existing links keep working.
  return port === undefined ? base : `${base}?port=${String(port)}`;
}

export const Browser = ({ projectId }: BrowserProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [cacheBust, setCacheBust] = useState(0);
  const [device, setDevice] = useState<DeviceValue>("responsive");
  const [loading, setLoading] = useState(true);

  /** Bumped by the server the moment the dev server answers its port. */
  const readyNonce = useRunStore((store) => store.readyNonce);
  const contentNonce = useRunStore((store) => store.contentNonce);
  const [autoReload, setAutoReload] = useState(true);

  /** Which container port to preview. A project often serves more than one
   *  thing — a frontend and the API beside it — and only one was reachable. */
  const [port, setPort] = useState<number | null>(null);

  const { data: portInfo } = useQuery({
    queryKey: ["projectPorts", projectId],
    queryFn: () => getProjectPorts(projectId),
    staleTime: Infinity,
  });

  const activePort = port ?? portInfo?.devPort ?? null;
  const src = previewUrl(
    projectId,
    activePort !== null && activePort !== portInfo?.devPort ? activePort : undefined,
  );
  const width = DEVICES.find((d) => d.value === device)?.width ?? null;

  // A different port is a different app; reload rather than showing the old one.
  useEffect(() => {
    setCacheBust((value) => value + 1);
  }, [activePort]);

  // Load the app as soon as it is actually up. The pane used to sit on
  // whatever it had — usually the "nothing running yet" page — until the user
  // pressed reload, with nothing telling them when that would work.
  useEffect(() => {
    if (readyNonce > 0 && autoReload) setCacheBust((value) => value + 1);
  }, [readyNonce, autoReload]);

  // A save the dev server may never hear about (a bind mount can swallow the
  // watcher's events), so the pane reloads on the server's word instead. A
  // request is compiled from disk, which is where the save verifiably landed.
  useEffect(() => {
    if (contentNonce > 0 && autoReload) setCacheBust((value) => value + 1);
  }, [contentNonce, autoReload]);

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

        {portInfo && portInfo.ports.length > 1 && (
          <Tooltip title="Port to preview">
            <Select
              size="small"
              value={activePort}
              onChange={setPort}
              style={{ minWidth: 92, fontFamily: "var(--rc-mono)" }}
              options={portInfo.ports.map((entry) => ({
                value: entry,
                label: `:${String(entry)}`,
              }))}
            />
          </Tooltip>
        )}

        <Segmented
          size="small"
          value={device}
          onChange={(value) => setDevice(value)}
          options={DEVICES.map((d) => ({
            value: d.value,
            label: <Tooltip title={d.title}>{d.label}</Tooltip>,
          }))}
        />

        <Tooltip
          title={
            autoReload
              ? "Reloading automatically when the dev server restarts"
              : "Not reloading automatically"
          }
        >
          <Button
            size="small"
            type="text"
            aria-label="Toggle automatic reload"
            aria-pressed={autoReload}
            onClick={() => setAutoReload((value) => !value)}
            style={{
              color: autoReload ? "var(--rc-green)" : "var(--rc-text-subtle)",
              fontSize: 11,
              fontFamily: "var(--rc-mono)",
            }}
          >
            AUTO
          </Button>
        </Tooltip>

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
            sandbox={SANDBOX}
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
