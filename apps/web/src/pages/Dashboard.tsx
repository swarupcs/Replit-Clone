import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Empty, Flex, List, Popconfirm, Spin, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  createProjectApi,
  deleteProjectApi,
  listProjectsApi,
} from "../apis/projects.ts";
import { useAuth } from "../hooks/useAuth.ts";

export const Dashboard = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();
  const [creating, setCreating] = useState(false);

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsApi,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProjectApi,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  async function handleCreate() {
    setCreating(true);
    try {
      const project = await createProjectApi();
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/project/${project.id}`);
    } catch {
      void messageApi.error("Could not create the project. Check the server logs.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#282a36", padding: 32 }}>
      {contextHolder}
      <Flex justify="space-between" align="center" style={{ marginBottom: 24 }}>
        <Typography.Title level={3} style={{ color: "white", margin: 0 }}>
          Your projects
        </Typography.Title>
        <Flex gap={12} align="center">
          <Typography.Text style={{ color: "#959eba" }}>{user?.email}</Typography.Text>
          <Button onClick={() => void logout()}>Sign out</Button>
        </Flex>
      </Flex>

      <Card>
        <Flex justify="end" style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={creating}
            onClick={() => void handleCreate()}
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
    </div>
  );
};
