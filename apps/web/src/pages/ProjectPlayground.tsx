import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Alert, Button, Flex, Tooltip, Typography } from "antd";
import {
  VscFiles,
  VscLayoutPanel,
  VscLayoutSidebarLeft,
  VscKey,
  VscSearch,
  VscSettingsGear,
} from "react-icons/vsc";
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
import { EditorSettingsDialog } from "../components/organisms/EditorSettingsDialog/EditorSettingsDialog.tsx";
import { SearchPanel } from "../components/organisms/SearchPanel/SearchPanel.tsx";
import { useHotkeys } from "../hooks/useHotkeys.ts";
import { useUnsavedWorkGuard } from "../hooks/useUnsavedWorkGuard.ts";
import { useWorkspaceSession } from "../hooks/useWorkspaceSession.ts";
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

  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  const { restored, remember } = useWorkspaceSession(projectIdFromUrl, editorSocket);

  // Seeded from the remembered arrangement, so a reload comes back to the
  // layout the user left rather than the defaults.
  const [showPreview, setShowPreview] = useState(restored?.showPreview ?? false);
  const [showSidebar, setShowSidebar] = useState(restored?.showSidebar ?? true);
  const [showPanel, setShowPanel] = useState(restored?.showPanel ?? true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which sidebar view is showing. */
  const [sidebarView, setSidebarView] = useState<"files" | "search">("files");

  const closeActiveTab = useOpenTabsStore((state) => state.closeTab);
  /** The project whose tabs are currently loaded, so re-running the effect for
   *  the same project does not discard them. */
  const openedProjectRef = useRef<string | undefined>(undefined);

  useUnsavedWorkGuard();

  // Each toggle records its new state, so the arrangement survives a reload.
  const toggleSidebar = useCallback(() => {
    setShowSidebar((value) => {
      remember({ showSidebar: !value });
      return !value;
    });
  }, [remember]);

  const togglePanel = useCallback(() => {
    setShowPanel((value) => {
      remember({ showPanel: !value });
      return !value;
    });
  }, [remember]);

  const togglePreview = useCallback(() => {
    setShowPreview((value) => {
      remember({ showPreview: !value });
      return !value;
    });
  }, [remember]);

  useHotkeys(
    useMemo(
      () => [
        { key: "p", mod: true, handler: () => setQuickOpen(true) },
        {
          key: "f",
          mod: true,
          shift: true,
          handler: () => {
            setSidebarView("search");
            setShowSidebar(true);
          },
        },
        { key: "b", mod: true, handler: () => toggleSidebar() },
        { key: "`", mod: true, handler: () => togglePanel() },
        { key: "j", mod: true, handler: () => togglePreview() },
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
      [closeActiveTab, toggleSidebar, togglePanel, togglePreview],
    ),
  );

  useEffect(() => {
    if (!projectIdFromUrl || !hasSession) return;

    // Cleared on the way IN rather than on the way out. Doing it in the
    // cleanup emptied the tab list while the workspace subscription was still
    // listening, which wrote "nothing open" over the session that reload was
    // about to restore.
    if (openedProjectRef.current !== projectIdFromUrl) {
      openedProjectRef.current = projectIdFromUrl;
      closeAllTabs();
    }

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
            <Tooltip title="Editor settings">
              <button
                className="rc-icon-button"
                aria-label="Editor settings"
                onClick={() => setSettingsOpen(true)}
              >
                <VscSettingsGear size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Environment variables">
              <button
                className="rc-icon-button"
                aria-label="Environment variables"
                onClick={() => setEnvOpen(true)}
              >
                <VscKey size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle file tree (Ctrl+B)">
              <button
                className="rc-icon-button"
                data-on={showSidebar}
                aria-label="Toggle file tree"
                onClick={toggleSidebar}
              >
                <VscLayoutSidebarLeft size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle panel (Ctrl+`)">
              <button
                className="rc-icon-button"
                data-on={showPanel}
                aria-label="Toggle panel"
                onClick={togglePanel}
              >
                <VscLayoutPanel size={15} />
              </button>
            </Tooltip>
            <Tooltip title="Toggle preview (Ctrl+J)">
              <button
                className="rc-icon-button"
                data-on={showPreview}
                aria-label="Toggle preview"
                onClick={togglePreview}
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
          defaultSize={restored?.sidebarWidth ?? 260}
          minSize={180}
          maxSize={520}
          showFirst={showSidebar}
          onResizeEnd={(size) => remember({ sidebarWidth: size })}
          first={
            <div
              style={{
                height: "100%",
                display: "flex",
                backgroundColor: "var(--rc-surface-sunken)",
              }}
            >
              {/* Activity rail. Both views stay mounted: search holds a query
                  and its results, and losing them on every glance at the tree
                  would make it useless. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "8px 4px",
                  borderRight: "1px solid var(--rc-border)",
                  flex: "none",
                }}
              >
                <Tooltip title="Explorer" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "files"}
                    aria-label="Explorer"
                    onClick={() => setSidebarView("files")}
                  >
                    <VscFiles size={16} />
                  </button>
                </Tooltip>
                <Tooltip title="Search (Ctrl+Shift+F)" placement="right">
                  <button
                    className="rc-icon-button"
                    data-on={sidebarView === "search"}
                    aria-label="Search"
                    onClick={() => setSidebarView("search")}
                  >
                    <VscSearch size={16} />
                  </button>
                </Tooltip>
              </div>

              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "files" ? "block" : "none",
                    overflow: "auto",
                  }}
                >
                  <ErrorBoundary label="The file tree">
                    <TreeStructure />
                  </ErrorBoundary>
                </div>

                <div
                  style={{
                    height: "100%",
                    display: sidebarView === "search" ? "block" : "none",
                  }}
                >
                  <ErrorBoundary label="Search">
                    <SearchPanel />
                  </ErrorBoundary>
                </div>
              </div>
            </div>
          }
          second={
            <SplitPane
              direction="horizontal"
              defaultSize={restored?.previewWidth ?? 700}
              minSize={320}
              showSecond={showPreview}
              onResizeEnd={(size) => remember({ previewWidth: size })}
              first={
                <SplitPane
                  direction="vertical"
                  defaultSize={restored?.panelHeight ?? 420}
                  minSize={120}
                  showSecond={showPanel}
                  onResizeEnd={(size) => remember({ panelHeight: size })}
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

      <EditorSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

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
