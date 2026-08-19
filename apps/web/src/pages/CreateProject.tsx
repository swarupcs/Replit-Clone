import { Button, Col, Flex, Row } from "antd";
import { useNavigate } from "react-router-dom";
import { useCreateProject } from "../hooks/apis/mutations/useCreateProject.ts";

export const CreateProject = () => {
  const { createProjectMutation, isPending } = useCreateProject();
  const navigate = useNavigate();

  async function handleCreateProject() {
    try {
      const response = await createProjectMutation();
      navigate(`/project/${response.data}`);
    } catch (error) {
      console.error("Error creating project", error);
    }
  }

  return (
    <Row>
      <Col span={24}>
        <Flex justify="center" align="center">
          <Button type="primary" loading={isPending} onClick={handleCreateProject}>
            Create Playground
          </Button>
        </Flex>
      </Col>
    </Row>
  );
};
