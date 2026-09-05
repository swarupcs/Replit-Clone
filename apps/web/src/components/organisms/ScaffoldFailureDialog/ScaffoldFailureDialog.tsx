import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Modal, Typography } from "antd";
import type { Project } from "@replit-clone/shared";
import { getScaffoldStateApi, retryScaffoldApi } from "../../../apis/projects.ts";

/** Why a "Latest" project did not get built, and what to do about it.
 *
 *  The reason is the entire content of this dialog. "Creation failed" is not
 *  something anybody can act on; "npm ERR! network timeout" tells you to try
 *  again, and "Cannot find module" tells you not to bother until upstream is
 *  fixed. So the scaffolder's own last words are shown verbatim rather than
 *  summarised into something reassuring and useless.
 *
 *  Two ways out, and both are offered because they are genuinely different
 *  decisions: **Try again** empties the tree and re-runs the recipe, which is
 *  right when the network was down; **Delete** is right when the recipe itself
 *  is broken and retrying would fail identically. Nothing here silently
 *  substitutes the pinned starter — quietly handing somebody a different, older
 *  project than the one they asked for is worse than telling them it failed.
 */
export function ScaffoldFailureDialog({
  project,
  onClose,
  onRetried,
  onDelete,
}: {
  project: Project | null;
  onClose: () => void;
  onRetried: () => void;
  onDelete: (project: Project) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["scaffold", project?.id],
    queryFn: () => getScaffoldStateApi(project?.id ?? ""),
    enabled: project !== null,
    retry: false,
  });

  async function retry() {
    if (!project) return;
    setRetrying(true);
    setProblem(null);
    try {
      await retryScaffoldApi(project.id);
      onRetried();
    } catch (error) {
      setProblem(
        (error as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not start it again.",
      );
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Modal
      open={project !== null}
      title={project ? `${project.name} was not built` : ""}
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button
          key="delete"
          danger
          onClick={() => {
            if (project) onDelete(project);
          }}
        >
          Delete it
        </Button>,
        <Button key="close" onClick={onClose}>
          Leave it
        </Button>,
        <Button
          key="retry"
          type="primary"
          loading={retrying}
          onClick={() => void retry()}
        >
          Try again
        </Button>,
      ]}
    >
      <Typography.Paragraph style={{ fontSize: 13 }}>
        The setup tool for this template did not finish. Nothing was installed,
        and trying again empties the folder and starts over.
      </Typography.Paragraph>

      {/* Verbatim, in a monospace block, scrollable. It is output from a
          program, and reflowing it as prose makes a stack trace unreadable. */}
      {data?.log && (
        <pre
          aria-label="What the setup tool said"
          style={{
            margin: 0,
            padding: 10,
            maxHeight: 220,
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: "var(--rc-mono)",
            background: "var(--rc-surface-sunken, rgba(0,0,0,0.25))",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data.log}
        </pre>
      )}

      {problem && (
        <Alert type="error" showIcon style={{ marginTop: 10 }} message={problem} />
      )}
    </Modal>
  );
}

export default ScaffoldFailureDialog;
