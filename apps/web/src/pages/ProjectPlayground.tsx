import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { Alert, Button, Flex, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { SplitPane } from "../components/layout/SplitPane.tsx";
import { EditorComponent } from "../components/molecules/EditorComponent/EditorComponent.tsx";
import { BrowserTerminal } from "../components/molecules/BrowserTerminal/BrowserTerminal.tsx";
import { TreeStructure } from "../components/organisms/TreeStructure/TreeStructure.tsx";
import { Browser } from "../components/organisms/Browser/Browser.tsx";
import { useTreeStructureStore } from "../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../store/editorSocketStore.ts";
import { useActiveFileTabStore } from "../store/activeFileTabStore.ts";
import { useAuthStore } from "../store/authStore.ts";
import type { EditorSocket } from "../store/editorSocketStore.ts";

export const ProjectPlayground = () => {
  const { projectId: projectIdFromUrl } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const accessToken = useAuthStore((state) => state.accessToken);
  const { setProjectId } = useTreeStructureStore();
  const { setEditorSocket, lastError, clearError } = useEditorSocketStore();
  const { activeFileTab, clearActiveFileTab } = useActiveFileTabStore();

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
      clearActiveFileTab();
    };
  }, [
    projectIdFromUrl,
    accessToken,
    setProjectId,
    setEditorSocket,
    clearActiveFileTab,
  ]);

  return (
    <Flex vertical style={{ height: "100vh", backgroundColor: "#282a36" }}>
      <Flex
        align="center"
        justify="space-between"
        style={{
          padding: "6px 12px",
          backgroundColor: "#22212b",
          borderBottom: "1px solid #44475a",
        }}
      >
        <Flex align="center" gap={10}>
          <Button
            size="small"
            type="text"
            icon={<ArrowLeftOutlined />}
            style={{ color: "#c8cad4" }}
            onClick={() => navigate("/")}
          />
          <Typography.Text style={{ color: "#c8cad4", fontSize: 13 }}>
            {activeFileTab?.relPath ?? "No file open"}
          </Typography.Text>
        </Flex>

        <Button size="small" onClick={() => setShowPreview((value) => !value)}>
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
                backgroundColor: "#21222c",
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
                  first={<EditorComponent />}
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
