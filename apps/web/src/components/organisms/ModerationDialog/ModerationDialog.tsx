import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Modal, Typography, message } from "antd";
import { MAX_APPEAL, type ModerationAction } from "@replit-clone/shared";
import {
  appealTakedownApi,
  listProjectModerationApi,
} from "../../../apis/projects.ts";

/** What a moderator decided about this project, and the owner's reply.
 *
 *  §2.17 shipped the trail, the appeal and the reinstatement on the server and
 *  nothing anywhere that called them. So a takedown was a notification and
 *  then a dead end: the owner could not read what was decided, could not
 *  answer it, and had no route back at all — which is exactly the property
 *  §2.16 removed when it made a takedown stick, and exactly what the appeal
 *  was built to restore.
 *
 *  The trail is shown whether or not anything was taken down. Dismissals are
 *  in it too, and "somebody reported this and a moderator looked and found
 *  nothing" is worth being able to read: a project reported and cleared ten
 *  times reads differently from one never reported, but only if the clearings
 *  are visible.
 */
interface ModerationDialogProps {
  projectId: string;
  projectName: string;
  /** ISO instant, or null when nothing has been taken down. Decides whether
   *  the appeal form is offered at all. */
  takenDownAt: string | null;
  open: boolean;
  onClose: () => void;
}

const VERB: Record<ModerationAction["action"], string> = {
  ACTIONED: "Taken down",
  DISMISSED: "Report dismissed",
  APPEALED: "You appealed",
  REINSTATED: "Put back",
};

/** What a takedown actually does, said here rather than left to be discovered
 *  one surface at a time. Every line is a query in the server that filters on
 *  `takenDownAt`, and none of it was written down anywhere the person it
 *  happened to could read. */
const CONSEQUENCES = [
  "The project is private, and making it public again is refused while this stands.",
  "Its published site is no longer served, and its build was removed.",
  "Its embed link and its share link no longer work.",
  "Its scheduled jobs are held — not deleted, and they resume if this is lifted.",
  "It cannot be forked, duplicated or deployed.",
];

export const ModerationDialog = ({
  projectId,
  projectName,
  takenDownAt,
  open,
  onClose,
}: ModerationDialogProps) => {
  const [text, setText] = useState("");
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const {
    data: actions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["moderation", projectId],
    queryFn: () => listProjectModerationApi(projectId),
    enabled: open,
    // Owner-only on the server, so a collaborator gets a 403 that three
    // retries will not turn into anything else.
    retry: false,
  });

  const appeal = useMutation({
    mutationFn: () => appealTakedownApi(projectId, text.trim()),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({
        queryKey: ["moderation", projectId],
      });
      void messageApi.success("Appeal sent.");
    },
    onError: (mutationError) => {
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } })
          .response?.data?.message ?? "Could not send that appeal.",
      );
    },
  });

  // Compared against the CURRENT takedown rather than "has ever appealed",
  // the same way the server compares it: a project taken down, put back, and
  // taken down again is a new case the owner is entitled to answer.
  const appealed =
    takenDownAt !== null &&
    (actions ?? []).some(
      (action) =>
        action.action === "APPEALED" &&
        new Date(action.createdAt) >= new Date(takenDownAt),
    );

  return (
    <Modal
      title={`Moderation — ${projectName}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
    >
      {contextHolder}

      {takenDownAt && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="A moderator took this project down after a report."
          description={
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
              {CONSEQUENCES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          }
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        What happened
      </Typography.Title>

      {error ? (
        <Empty description="Could not load this project's moderation history." />
      ) : isLoading ? (
        <div
          aria-label="Loading moderation history"
          style={{ display: "grid", gap: 8 }}
        >
          {Array.from({ length: 2 }, (_, index) => (
            <span
              key={index}
              className="rc-skeleton"
              style={{ height: 34 }}
              aria-hidden="true"
            />
          ))}
        </div>
      ) : (actions ?? []).length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Nobody has ever reported this project."
        />
      ) : (
        <ol
          aria-label="Moderation history"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 10,
          }}
        >
          {actions?.map((action) => (
            <li key={action.id} className="rc-card" style={{ padding: 12 }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <Typography.Text strong style={{ fontSize: 13.5 }}>
                  {VERB[action.action]}
                </Typography.Text>
                <Typography.Text
                  style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
                >
                  {new Date(action.createdAt).toLocaleString()}
                </Typography.Text>
              </div>
              {action.reason && (
                <Typography.Paragraph
                  style={{
                    margin: "6px 0 0",
                    fontSize: 13,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {action.reason}
                </Typography.Paragraph>
              )}
            </li>
          ))}
        </ol>
      )}

      {takenDownAt && !appealed && (
        <>
          <Typography.Title level={5}>Appeal this</Typography.Title>
          <Typography.Paragraph
            style={{
              color: "var(--rc-text-subtle)",
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            One appeal per takedown. Say what you think was misread — an
            operator reads it against the report.
          </Typography.Paragraph>
          <Input.TextArea
            aria-label="Your appeal"
            rows={4}
            maxLength={MAX_APPEAL}
            showCount
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            placeholder="What was misunderstood?"
          />
          <Button
            type="primary"
            style={{ marginTop: 10 }}
            disabled={text.trim().length === 0}
            loading={appeal.isPending}
            onClick={() => {
              appeal.mutate();
            }}
          >
            Send appeal
          </Button>
        </>
      )}

      {appealed && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message="Your appeal is with an operator."
          description="You will be told if the takedown is lifted. Putting a project back restores your control of it, not its visibility — it stays private, and what to do with it is yours to decide again."
        />
      )}
    </Modal>
  );
};

export default ModerationDialog;
