import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Alert, Button, Flex, Tooltip, Typography } from "antd";
import { VscLayoutPanel, VscLayoutSidebarLeft, VscSettingsGear } from "react-icons/vsc";
import {
  ArrowLeftOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { SplitPane } from "../components/layout/SplitPane.tsx";
import { EditorComponent } from "../components/molecules/EditorComponent/EditorComponent.tsx";
import { EditorTabs } from "../components/molecules/EditorTabs/EditorTabs.tsx";
import { BottomPanel } from "../components/organisms/BottomPanel/BottomPanel.tsx";
import { TreeStructure } from "../components/organisms/TreeStructure/TreeStructure.tsx";
import { Browser } from "../components/organisms/Browser/Browser.tsx";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../store/editorSocketStore.ts";
import { useOpenTabsStore, selectActiveTab } from "../store/openTabsStore.ts";
import { useAuthStore } from "../store/authStore.ts";
import { useRunStore } from "../store/runStore.ts";
import { RunControl } from "../components/molecules/RunControl/RunControl.tsx";
import { ErrorBoundary } from "../components/routing/ErrorBoundary.tsx";
import { QuickOpen } from "../components/organisms/QuickOpen/QuickOpen.tsx";
import { EnvVarsDialog } from "../components/organisms/EnvVarsDialog/EnvVarsDialog.tsx";
import { useHotkeys } from "../hooks/useHotkeys.ts";
import { useUnsavedWorkGuard } from "../hooks/useUnsavedWorkGuard.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

export const ProjectPlayground = () => {
  const { projectId: projectIdFromUrl } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  /** Whether a session exists — NOT the token itself. It rotates roughly every
   *  fifteen minutes, and depending on its value tore down the editor socket
   *  (and, through the panel, every terminal) each time it did. */
  const hasSession = useAuthStore((state) => state.accessToken !== null);
  const { setProjectId } = useTreeStructureStore();
  const { setEditorSocket, lastError, clearError } = useEditorSocketStore();
  const activeTab = useOpenTabsStore(selectActiveTab);
  const closeAllTabs = useOpenTabsStore((state) => state.closeAll);

  const [showPreview, setShowPreview] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  const closeActiveTab = useOpenTabsStore((state) => state.closeTab);

  useUnsavedWorkGuard();

  useHotkeys(
    useMemo(
      () => [
        { key: "p", mod: true, handler: () => setQuickOpen(true) },
        { key: "b", mod: true, handler: () => setShowSidebar((value) => !value) },
        { key: "`", mod: true, handler: () => setShowPanel((value) => !value) },
        {
          key: "j",
          mod: true,
          handler: () => setShowPreview((value) => !value),
        },
        {
          // Ctrl+W is the browser's own close-tab and cannot be reclaimed, so
          // closing an editor tab uses the Alt variant.
          key: "w",
          mod: true,
          alt: true,
          handler: () => {
            const active = useOpenTabsStore.getState().activeRelPath;
            if (active) closeActiveTab(active);
          },
        },
      ],
      [closeActiveTab],
    ),
  );

  useEffect(() => {
    if (!projectIdFromUrl || !hasSession) return;

    setProjectId(projectIdFromUrl);

    const editorSocketConn: EditorSocket = io(
      `${import.meta.env.VITE_BACKEND_URL}/editor`,
      {
        query: { projectId: projectIdFromUrl },
        // Resolved per connection attempt rather than captured, so a reconnect
        // after the token rotated presents the current one. The handshake is
        // rejected without it; the server also verifies the caller owns this
        // project before registering any handler.
        auth: (cb: (data: Record<string, unknown>) => void) => {
          cb({ token: useAuthStore.getState().accessToken });
        },
      },
    );
    setEditorSocket(editorSocketConn);

    // Dev server state lives on the server and survives a page reload, so ask
    // for it rather than assuming "idle" on every mount.
    const run = useRunStore.getState();
    editorSocketConn.on("runState", run.setState);
    editorSocketConn.on("runOutput", ({ chunk }) => {
      useRunStore.getState().appendOutput(chunk);
    });
    editorSocketConn.on("runHistory", ({ chunks }) => {
      useRunStore.getState().replaceOutput(chunks);
    });
    editorSocketConn.on("previewReady", () => {
      useRunStore.getState().markPreviewReady();
    });
    editorSocketConn.on("containerStats", (stats) => {
      useRunStore.getState().setStats(stats);
    });
    editorSocketConn.emit("runSubscribe");

    // One sample a few seconds apart. Docker computes CPU from the delta since
    // the previous reading, so the first is always zero; polling is what makes
    // the number mean anything.
    const statsTimer = setInterval(() => {
      editorSocketConn.emit("statsRequest");
    }, 5000);
    editorSocketConn.emit("statsRequest");

    return () => {
      clearInterval(statsTimer);
      editorSocketConn.disconnect();
      setEditorSocket(null);
      closeAllTabs();
      useRunStore.getState().reset();
    };
  }, [
    projectIdFromUrl,
    hasSession,
    setProjectId,
    setEditorSocket,
    closeAllTabs,
  ]);

  return (
    <Flex vertical style={{ height: "100vh", backgroundColor: "var(--rc-surface)" }}>
      <Flex
        align="center"
        justify="space-between"
        style={{
          padding: "8px 14px",
          backgroundColor: "var(--rc-surface-raised)",
          borderBottom: "1px solid var(--rc-border)",
          gap: 12,
        }}
      >
        <Flex align="center" gap={10} style={{ minWidth: 0 }}>
          <Button
            size="small"
            type="text"
            icon={<ArrowLeftOutlined />}
            style={{ color: "var(--rc-text-muted)" }}
            onClick={() => void navigate("/")}
          />
          <span
            aria-hidden
            style={{
              width: 1,
              height: 18,
              background: "var(--rc-border)",
              flex: "none",
            }}
          />
          <Typography.Text
            ellipsis
            style={{
              color: "var(--rc-text-muted)",
              fontSize: 12.5,
              fontFamily: "var(--rc-mono)",
            }}
          >
            {activeTab?.relPath ?? "No file open"}
          </Typography.Text>
        </Flex>

        <Flex align="center" gap={12}>
          <RunControl />

          <Flex align="center" gap={2}>
            <Tooltip title="Environment variables">
              <button
                className="rc-icon-button"
                aria-label="Environment variables"
                onClick={() => setEnvOpen(true)}
              >
                <VscSettingsGear size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle file tree (Ctrl+B)">
              <button
                className="rc-icon-button"
                data-on={showSidebar}
                aria-label="Toggle file tree"
                onClick={() => setShowSidebar((value) => !value)}
              >
                <VscLayoutSidebarLeft size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle panel (Ctrl+`)">
              <button
                className="rc-icon-button"
                data-on={showPanel}
                aria-label="Toggle panel"
                onClick={() => setShowPanel((value) => !value)}
              >
                <VscLayoutPanel size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle preview (Ctrl+J)">
              <button
                className="rc-icon-button"
                data-on={showPreview}
                aria-label="Toggle preview"
                onClick={() => setShowPreview((value) => !value)}
              >
                {showPreview ? (
                  <EyeInvisibleOutlined />
                ) : (
                  <EyeOutlined />
                )}
              </button>
            </Tooltip>
          </Flex>
        </Flex>
      </Flex>

      {lastError && (
        <Alert
          type="error"
          banner
          closable
          message={lastError}
          onClose={clearError}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitPane
          direction="horizontal"
          defaultSize={260}
          minSize={180}
          maxSize={520}
          showFirst={showSidebar}
          first={
            <div
              style={{
                height: "100%",
                overflow: "auto",
                backgroundColor: "var(--rc-surface-sunken)",
              }}
            >
              <ErrorBoundary label="The file tree">
                <TreeStructure />
              </ErrorBoundary>
            </div>
          }
          second={
            <SplitPane
              direction="horizontal"
              defaultSize={700}
              minSize={320}
              showSecond={showPreview}
              first={
                <SplitPane
                  direction="vertical"
                  defaultSize={420}
                  minSize={120}
                  showSecond={showPanel}
                  first={
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        height: "100%",
                      }}
                    >
                      <EditorTabs />
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <ErrorBoundary label="The editor">
                          <EditorComponent />
                        </ErrorBoundary>
                      </div>
                    </div>
                  }
                  second={
                    projectIdFromUrl ? (
                      <ErrorBoundary label="The terminal panel">
                        <BottomPanel projectId={projectIdFromUrl} />
                      </ErrorBoundary>
                    ) : null
                  }
                />
              }
              second={
                projectIdFromUrl ? (
                  <ErrorBoundary label="The preview">
                    <Browser projectId={projectIdFromUrl} />
                  </ErrorBoundary>
                ) : null
              }
            />
          }
        />
      </div>

      <QuickOpen open={quickOpen} onClose={() => setQuickOpen(false)} />

      {projectIdFromUrl && (
        <EnvVarsDialog
          projectId={projectIdFromUrl}
          open={envOpen}
          onClose={() => setEnvOpen(false)}
        />
      )}
    </Flex>
  );
};
