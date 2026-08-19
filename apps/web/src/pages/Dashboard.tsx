import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Spin,
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
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--rc-surface)",
        padding: 32,
      }}
    >
      {contextHolder}

      <Flex justify="space-between" align="center" style={{ marginBottom: 24 }}>
        <Typography.Title level={3} style={{ color: "var(--rc-text)", margin: 0 }}>
          Your projects
        </Typography.Title>
        <Flex gap={12} align="center">
          <Typography.Text style={{ color: "var(--rc-text-muted)" }}>
            {user?.email}
          </Typography.Text>
          <Button onClick={() => void logout()}>Sign out</Button>
        </Flex>
      </Flex>

      <Card>
        <Flex justify="end" style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setIsCreating(true)}
          >
            New playground
          </Button>
        </Flex>

        {isLoading ? (
          <Flex justify="center" style={{ padding: 32 }}>
            <Spin />
          </Flex>
        ) : projects && projects.length > 0 ? (
          <List
            dataSource={projects}
            renderItem={(project) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title="Delete this project?"
                    description="The files are removed from disk permanently."
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => deleteMutation.mutate(project.id)}
                  >
                    <Button danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <a onClick={() => navigate(`/project/${project.id}`)}>
                      {project.name}
                    </a>
                  }
                  description={`${project.template} · created ${new Date(
                    project.createdAt,
                  ).toLocaleDateString()}`}
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="No projects yet" />
        )}
      </Card>

      <Modal
        open={isCreating}
        title="New playground"
        okText="Create"
        confirmLoading={creating}
        onOk={() => void handleCreate()}
        onCancel={() => setIsCreating(false)}
        destroyOnHidden
      >
        <Flex vertical gap={16} style={{ marginTop: 16 }}>
          <Input
            autoFocus
            placeholder="Project name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          {templates && (
            <Segmented
              block
              value={selectedTemplate}
              onChange={(value) => setTemplate(String(value))}
              options={templates.map((t) => ({ label: t.label, value: t.id }))}
            />
          )}

          {activeTemplate && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Run it with <code>{activeTemplate.startCommand}</code>, then open
              the preview.
            </Typography.Text>
          )}
        </Flex>
      </Modal>
    </div>
  );
};
