import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Alert, Button, Flex, Typography } from "antd";
import {
  ArrowLeftOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { SplitPane } from "../components/layout/SplitPane.tsx";
import { EditorComponent } from "../components/molecules/EditorComponent/EditorComponent.tsx";
import { EditorTabs } from "../components/molecules/EditorTabs/EditorTabs.tsx";
import { BrowserTerminal } from "../components/molecules/BrowserTerminal/BrowserTerminal.tsx";
import { TreeStructure } from "../components/organisms/TreeStructure/TreeStructure.tsx";
import { Browser } from "../components/organisms/Browser/Browser.tsx";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../store/editorSocketStore.ts";
import { useOpenTabsStore, selectActiveTab } from "../store/openTabsStore.ts";
import { useAuthStore } from "../store/authStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

export const ProjectPlayground = () => {
  const { projectId: projectIdFromUrl } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const accessToken = useAuthStore((state) => state.accessToken);
  const { setProjectId } = useTreeStructureStore();
  const { setEditorSocket, lastError, clearError } = useEditorSocketStore();
  const activeTab = useOpenTabsStore(selectActiveTab);
  const closeAllTabs = useOpenTabsStore((state) => state.closeAll);

  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!projectIdFromUrl || !accessToken) return;

    setProjectId(projectIdFromUrl);

    const editorSocketConn: EditorSocket = io(
      `${import.meta.env.VITE_BACKEND_URL}/editor`,
      {
        query: { projectId: projectIdFromUrl },
        // The handshake is rejected without this; the server also verifies the
        // caller owns this project before registering any handler.
        auth: { token: accessToken },
      },
    );
    setEditorSocket(editorSocketConn);

    return () => {
      editorSocketConn.disconnect();
      setEditorSocket(null);
      closeAllTabs();
    };
  }, [
    projectIdFromUrl,
    accessToken,
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
            onClick={() => navigate("/")}
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

        <Button
          size="small"
          type={showPreview ? "primary" : "default"}
          icon={showPreview ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          onClick={() => setShowPreview((value) => !value)}
        >
          {showPreview ? "Hide preview" : "Show preview"}
        </Button>
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
          first={
            <div
              style={{
                height: "100%",
                overflow: "auto",
                backgroundColor: "var(--rc-surface-sunken)",
              }}
            >
              <TreeStructure />
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
                        <EditorComponent />
                      </div>
                    </div>
                  }
                  second={
                    projectIdFromUrl && accessToken ? (
                      <BrowserTerminal
                        projectId={projectIdFromUrl}
                        accessToken={accessToken}
                      />
                    ) : null
                  }
                />
              }
              second={
                projectIdFromUrl ? <Browser projectId={projectIdFromUrl} /> : null
              }
            />
          }
        />
      </div>
    </Flex>
  );
};
