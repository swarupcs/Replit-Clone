import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button, Empty, Typography, message } from "antd";
import { VscRepoForked } from "react-icons/vsc";
import {
  forkProjectApi,
  listPublicProjectsApi,
} from "../../../apis/projects.ts";
import { ReportProject } from "../../molecules/ReportProject/ReportProject.tsx";

/** Projects other people have published, and a way to take a copy.
 *
 *  This is the half of the product that did not exist: `Duplicate` copies a
 *  project you already own and `Share` invites a named person, so there was no
 *  path from "somebody made a thing" to "I have my own copy of it" without an
 *  invitation first. That path is what makes a template gallery or a shared
 *  tutorial link work at all.
 *
 *  A fork is not a way into the original. It carries the files and none of the
 *  arrangements around them — no environment variables, no git history, no
 *  collaborators — and it starts private however public its source was.
 */
export const ExploreSection = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data: projects, isLoading } = useQuery({
    queryKey: ["public-projects"],
    queryFn: listPublicProjectsApi,
  });

  const forkMutation = useMutation({
    mutationFn: (projectId: string) => forkProjectApi(projectId),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      // Straight into it. The point of forking is to start working, and
      // leaving somebody on a list to find their own copy is a step that
      // exists only because it was easier to build.
      void navigate(`/project/${project.id}`);
    },
    onError: (error) => {
      void messageApi.error(
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not fork that project.",
      );
    },
  });

  // Nothing published yet is the ordinary state of a fresh install, and an
  // empty panel saying so is worse than no panel at all.
  if (!isLoading && (projects?.length ?? 0) === 0) return null;

  return (
    <section style={{ marginTop: 40 }} aria-labelledby="rc-explore-heading">
      {contextHolder}

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <Typography.Title
          id="rc-explore-heading"
          level={4}
          style={{ margin: 0, fontSize: 16 }}
        >
          Explore
        </Typography.Title>
        <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}>
          Published by other people. Take a copy and it is yours.
        </Typography.Text>
      </div>

      {isLoading ? (
        <div className="rc-project-grid" aria-label="Loading public projects">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="rc-skeleton-card" aria-hidden="true">
              <span className="rc-skeleton" style={{ width: "58%", height: 15 }} />
              <span className="rc-skeleton" style={{ width: "84%", height: 11 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="rc-project-grid">
          {projects?.map((project) => (
            <div key={project.id} className="rc-card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Typography.Text strong ellipsis style={{ fontSize: 14 }}>
                  {project.name}
                </Typography.Text>
                <span className="rc-badge">{project.template}</span>
              </div>

              <Typography.Text
                style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
              >
                by {project.ownerName}
                {project.forks > 0 &&
                  ` · ${String(project.forks)} ${project.forks === 1 ? "fork" : "forks"}`}
              </Typography.Text>

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Button
                  size="small"
                  onClick={() => void navigate(`/project/${project.id}`)}
                >
                  Look inside
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<VscRepoForked size={12} />}
                  loading={
                    forkMutation.isPending &&
                    forkMutation.variables === project.id
                  }
                  onClick={() => {
                    forkMutation.mutate(project.id);
                  }}
                >
                  Fork
                </Button>
                {/* Last, small, and quiet. Reporting is the rare action on this
                    card and should not compete with the two that are not. */}
                <div style={{ marginLeft: "auto" }}>
                  <ReportProject
                    projectId={project.id}
                    projectName={project.name}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && projects?.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nobody has published a project yet."
        />
      )}
    </section>
  );
};
