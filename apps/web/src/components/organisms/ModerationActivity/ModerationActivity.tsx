import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Empty, Input, Modal, Typography, message } from "antd";
import { MAX_MODERATION_REASON, type ModerationAction } from "@replit-clone/shared";
import {
  listRecentModerationApi,
  reinstateProjectApi,
} from "../../../apis/projects.ts";

/** What happened after the decision.
 *
 *  The queue shows the case that arrives and stops there, so until this
 *  existed an appeal could be filed and never read, and a takedown that was
 *  wrong could not be lifted. §6 decision 11 says the moderation authority is
 *  small *because* it is unreviewed and must not grow until something reviews
 *  it — §2.17 built that something and nothing called it. This is the caller.
 *
 *  Nothing here grants an operator any authority they did not already have.
 *  Reinstating is the one action added, and it is the one that takes authority
 *  away rather than exercising it.
 */
const VERB: Record<ModerationAction["action"], string> = {
  ACTIONED: "Taken down",
  DISMISSED: "Dismissed",
  APPEALED: "Appealed",
  REINSTATED: "Put back",
};

/** An appeal nobody has answered: filed after the takedown it is about, with
 *  no reinstatement for that project since.
 *
 *  Derived from the stream rather than asked for separately, because the
 *  stream is already ordered and already carries both facts. The one thing it
 *  cannot see is an appeal older than the hundred most recent actions, which
 *  is a busier deployment than this has and would be a query, not a screen. */
function unansweredAppeals(actions: ModerationAction[]): Set<string> {
  const answered = new Set<string>();
  const open = new Set<string>();

  // Newest first, so anything seen before an appeal came after it.
  for (const action of actions) {
    if (!action.projectId) continue;

    if (action.action === "REINSTATED") answered.add(action.projectId);
    else if (action.action === "APPEALED" && !answered.has(action.projectId)) {
      open.add(action.id);
      // One appeal per takedown, so the first one seen for a project is the
      // live one; older entries below it belong to earlier cases.
      answered.add(action.projectId);
    }
  }

  return open;
}

export const ModerationActivity = () => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [reinstating, setReinstating] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState("");

  const {
    data: actions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["moderation-activity"],
    queryFn: listRecentModerationApi,
    // A 403 is the answer for everybody not on the allowlist, and retrying it
    // changes nothing except how long the page takes to say so.
    retry: false,
  });

  const open = useMemo(() => unansweredAppeals(actions ?? []), [actions]);

  const reinstate = useMutation({
    mutationFn: (input: { projectId: string; reason: string }) =>
      reinstateProjectApi(input.projectId, input.reason),
    onSuccess: () => {
      setReinstating(null);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["moderation-activity"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      void messageApi.success("Project put back.");
    },
    onError: (mutationError) => {
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } })
          .response?.data?.message ?? "Could not put that project back.",
      );
    },
  });

  if (error) {
    return (
      <Empty description="Could not load moderation history. This account may not be able to review reports." />
    );
  }

  if (isLoading) {
    return (
      <div aria-label="Loading moderation history" style={{ display: "grid", gap: 10 }}>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rc-skeleton-card" aria-hidden="true">
            <span className="rc-skeleton" style={{ width: "45%", height: 15 }} />
            <span className="rc-skeleton" style={{ width: "70%", height: 11 }} />
          </div>
        ))}
      </div>
    );
  }

  if ((actions ?? []).length === 0) {
    return <Empty description="Nothing has been decided yet." />;
  }

  return (
    <>
      {contextHolder}

      <ul
        aria-label="Moderation history"
        style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
      >
        {actions?.map((action) => {
          const needsAnswer = open.has(action.id);

          return (
            <li key={action.id} className="rc-card">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Typography.Text strong style={{ fontSize: 14 }}>
                  {action.projectName}
                </Typography.Text>
                <span className="rc-badge">{VERB[action.action]}</span>
                {needsAnswer && (
                  <span
                    className="rc-badge"
                    style={{ color: "var(--rc-danger, #ff4d4f)" }}
                  >
                    waiting on you
                  </span>
                )}
                {/* SetNull, not Cascade: the trail outlives the project on
                    purpose, since a record that vanishes with its subject can
                    be erased by deleting the subject. */}
                {!action.projectId && (
                  <span className="rc-badge">project deleted</span>
                )}
              </div>

              <Typography.Text
                style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
              >
                {action.actor} · {new Date(action.createdAt).toLocaleString()}
              </Typography.Text>

              {action.reason && (
                <Typography.Paragraph
                  style={{ margin: "8px 0 0", fontSize: 13, whiteSpace: "pre-wrap" }}
                >
                  {action.reason}
                </Typography.Paragraph>
              )}

              {needsAnswer && action.projectId && (
                <div style={{ marginTop: 12 }}>
                  <Button
                    size="small"
                    onClick={() => {
                      setReinstating(action);
                      setReason("");
                    }}
                  >
                    Put it back
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Modal
        open={reinstating !== null}
        title={`Put back ${reinstating?.projectName ?? "this project"}`}
        okText="Put it back"
        confirmLoading={reinstate.isPending}
        okButtonProps={{ disabled: reason.trim().length === 0 }}
        onOk={() => {
          if (reinstating?.projectId) {
            reinstate.mutate({
              projectId: reinstating.projectId,
              reason: reason.trim(),
            });
          }
        }}
        onCancel={() => setReinstating(null)}
      >
        <Typography.Paragraph style={{ fontSize: 13 }}>
          This restores the owner&apos;s control, not the project. It stays
          private, its site and its files are gone, and what to do next is
          theirs to decide again.
        </Typography.Paragraph>
        <Input.TextArea
          aria-label="Why you are putting it back"
          rows={3}
          maxLength={MAX_MODERATION_REASON}
          showCount
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          placeholder="Why?"
        />
        <Typography.Paragraph
          style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginTop: 8 }}
        >
          Required. Of every action on this page it is the one an operator has
          most reason to leave unexplained, and &ldquo;we put it back&rdquo;
          with no account of why is the half of the record that makes the other
          half unfalsifiable.
        </Typography.Paragraph>
      </Modal>
    </>
  );
};

export default ModerationActivity;
