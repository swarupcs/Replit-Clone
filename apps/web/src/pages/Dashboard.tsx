import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Spin,
  Tooltip,
  Typography,
  message,
} from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  createProjectApi,
  deleteProjectApi,
  listProjectsApi,
  listTemplatesApi,
} from "../apis/projects.ts";
import { useAuth } from "../hooks/useAuth.ts";

/** Relative time for the card footer -- "3 days ago" reads better than a date
 *  when you're scanning a list of things you made recently. */
function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsPerUnit] of units) {
    if (seconds >= secondsPerUnit) {
      return formatter.format(-Math.floor(seconds / secondsPerUnit), unit);
    }
  }
  return "just now";
}

export const Dashboard = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();

  const [isCreating, setIsCreating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string | null>(null);

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsApi,
  });

  const { data: templates } = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplatesApi,
    staleTime: Infinity,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProjectApi,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const selectedTemplate = template ?? templates?.[0]?.id ?? "react-vite";
  const activeTemplate = templates?.find((t) => t.id === selectedTemplate);

  async function handleCreate() {
    setCreating(true);
    try {
      const project = await createProjectApi(name || undefined, selectedTemplate);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/project/${project.id}`);
    } catch {
      void messageApi.error("Could not create the project. Check the server logs.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="rc-aurora" style={{ minHeight: "100vh" }}>
      {contextHolder}

      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "16px 32px",
          borderBottom: "1px solid var(--rc-border)",
          background: "rgba(10, 11, 18, 0.6)",
          backdropFilter: "blur(12px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="rc-logo">&lt;/&gt;</span>
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>
            Playground
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Typography.Text
            style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}
          >
            {user?.email}
          </Typography.Text>
          <Button onClick={() => void logout()}>Sign out</Button>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "40px 32px 64px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 28,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: -0.8,
                marginBottom: 6,
              }}
            >
              Your projects
            </h1>
            <p style={{ color: "var(--rc-text-subtle)", fontSize: 14 }}>
              {projects?.length
                ? `${projects.length} playground${projects.length === 1 ? "" : "s"}`
                : "Nothing here yet — create your first playground."}
            </p>
          </div>

          <Button
            type="primary"
            size="large"
            icon={<PlusOutlined />}
            onClick={() => setIsCreating(true)}
          >
            New playground
          </Button>
        </div>

        {isLoading ? (
          <div style={{ display: "grid", placeItems: "center", padding: 80 }}>
            <Spin size="large" />
          </div>
        ) : projects && projects.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 18,
            }}
          >
            {projects.map((project) => (
              <div
                key={project.id}
                className="rc-card"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/project/${project.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigate(`/project/${project.id}`);
                  }
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span className="rc-badge">{project.template}</span>

                  {/* Stop propagation so the confirm popup doesn't also open
                      the project behind it. */}
                  <div
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Popconfirm
                      title="Delete this project?"
                      description="The files are removed from disk permanently."
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => deleteMutation.mutate(project.id)}
                    >
                      <Tooltip title="Delete">
                        <Button
                          danger
                          type="text"
                          size="small"
                          icon={<DeleteOutlined />}
                        />
                      </Tooltip>
                    </Popconfirm>
                  </div>
                </div>

                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    letterSpacing: -0.2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {project.name}
                </div>

                <div style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
                  Created {relativeTime(project.createdAt)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rc-panel" style={{ padding: "64px 24px" }}>
            <Empty
              description={
                <span style={{ color: "var(--rc-text-subtle)" }}>
                  No projects yet
                </span>
              }
            >
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setIsCreating(true)}
              >
                Create one
              </Button>
            </Empty>
          </div>
        )}
      </main>

      <Modal
        open={isCreating}
        title="New playground"
        okText="Create"
        confirmLoading={creating}
        onOk={() => void handleCreate()}
        onCancel={() => setIsCreating(false)}
        destroyOnHidden
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginTop: 20,
          }}
        >
          <Input
            autoFocus
            size="large"
            placeholder="Project name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          {templates && (
            <Segmented
              vertical
              block
              value={selectedTemplate}
              onChange={(value) => setTemplate(String(value))}
              options={templates.map((t) => ({ label: t.label, value: t.id }))}
            />
          )}

          {activeTemplate && (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, lineHeight: 1.6 }}
            >
              Run it with <code>{activeTemplate.startCommand}</code>, then open
              the preview.
            </Typography.Text>
          )}
        </div>
      </Modal>
    </div>
  );
};
