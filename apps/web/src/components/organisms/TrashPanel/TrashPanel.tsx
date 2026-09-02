import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Empty, Modal, Typography, message } from "antd";
import {
  listTrashApi,
  purgeProjectApi,
  restoreProjectApi,
  type TrashedProject,
} from "../../../apis/projects.ts";

/** What delete now means.
 *
 *  Everything a user has lived in exactly one place, and the path that removed
 *  it took the container, the managed database and its volume, the
 *  checkpoints, the published files and the working tree — with a confirmation
 *  dialog as the only thing in front of it.
 *
 *  This is the undo. It is not a backup: a backup answers "the host died" and
 *  needs somewhere off this machine to live, which is still an open question.
 *  This answers "I meant the other project", which is the one that happens.
 */
function daysLeft(deletedAt: string, trashDays: number): number {
  const gone = new Date(deletedAt).getTime() + trashDays * 86_400_000;
  return Math.max(0, Math.ceil((gone - Date.now()) / 86_400_000));
}

export const TrashPanel = () => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [purging, setPurging] = useState<TrashedProject | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["trash"],
    queryFn: listTrashApi,
    retry: false,
  });

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
    // The dashboard's list and the account's usage both change when something
    // comes back, and neither would refetch on its own.
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["account"] });
  };

  const restore = useMutation({
    mutationFn: restoreProjectApi,
    onSuccess: async () => {
      await done();
      void messageApi.success("Project restored.");
    },
    onError: (mutationError) => {
      // The interesting failure is the project limit: trashing stops a project
      // counting, so an account can be full by the time somebody changes their
      // mind. Saying which is far better than a card that stays put.
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } }).response
          ?.data?.message ?? "Could not restore that project.",
      );
    },
  });

  const purge = useMutation({
    mutationFn: purgeProjectApi,
    onSuccess: async () => {
      setPurging(null);
      await done();
      void messageApi.success("Project deleted.");
    },
    onError: () => {
      void messageApi.error("Could not delete that project.");
    },
  });

  if (error) return <Empty description="Could not load the trash." />;

  if (isLoading || !data) {
    return (
      <div aria-label="Loading trash" style={{ display: "grid", gap: 8 }}>
        <span className="rc-skeleton" style={{ height: 30 }} aria-hidden="true" />
      </div>
    );
  }

  if (data.projects.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Nothing deleted in the last week."
      />
    );
  }

  return (
    <>
      {contextHolder}

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}
      >
        Deleted projects are kept for {data.trashDays} days and then removed for
        good. They are stopped and offline in the meantime, and they do not
        count against your quota.
      </Typography.Paragraph>

      <ul
        aria-label="Trash"
        style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
      >
        {data.projects.map((project) => {
          const left = daysLeft(project.deletedAt, data.trashDays);

          return (
            <li key={project.id} className="rc-card" style={{ padding: 10 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {project.name}
                  </Typography.Text>
                  <span className="rc-badge">{project.template}</span>
                  <Typography.Text
                    style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
                  >
                    {/* The number somebody needs is how long they have, not
                        when they pressed the button. */}
                    {left === 0
                      ? "deleted for good today"
                      : `${String(left)} day${left === 1 ? "" : "s"} left`}
                  </Typography.Text>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    size="small"
                    type="primary"
                    loading={restore.isPending && restore.variables === project.id}
                    onClick={() => {
                      restore.mutate(project.id);
                    }}
                  >
                    Restore
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => setPurging(project)}
                  >
                    Delete now
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Modal
        open={purging !== null}
        title="Delete this project for good?"
        okText="Delete for good"
        okButtonProps={{ danger: true }}
        confirmLoading={purge.isPending}
        onOk={() => {
          if (purging) purge.mutate(purging.id);
        }}
        onCancel={() => setPurging(null)}
        destroyOnHidden
      >
        <span style={{ color: "var(--rc-text-muted)" }}>
          <b>{purging?.name}</b>, its files and its database are removed from
          disk permanently. This is the one that cannot be undone.
        </span>
      </Modal>
    </>
  );
};

export default TrashPanel;
