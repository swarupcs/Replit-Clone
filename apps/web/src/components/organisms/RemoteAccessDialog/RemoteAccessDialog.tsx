import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Modal, Typography, message } from "antd";
import type { RemoteAccess } from "@replit-clone/shared";
import { getRemoteAccessApi } from "../../../apis/projects.ts";

/** Attaching your own editor to this workspace. plan.md §10.1 Route C.
 *
 *  What §10.1 decided: Monaco stays as the browser editor, and the workspace
 *  becomes attachable so somebody's own VS Code, Cursor, Zed or nvim can open
 *  it. This is where they find out how.
 *
 *  The whole screen is one command and one link, because that is the whole
 *  feature. What it spends its space on instead is the four ways it can be
 *  unavailable, each said in the words of the thing the person has to change —
 *  a screen that showed a dead command with no explanation would send somebody
 *  to debug their SSH client, which is the one place the problem is not.
 */

/** Why not, in terms of what to do about it. */
const REASONS: Record<NonNullable<RemoteAccess["reason"]>, {
  title: string;
  detail: string;
}> = {
  disabled: {
    title: "Not turned on for this server",
    detail:
      "SANDBOX_SSH_ENABLED is off, so no workspace here accepts a connection. An operator turns it on.",
  },
  "no-key": {
    title: "No key on your account",
    detail:
      "Add a public key under Account → SSH keys, then start this workspace again. A key added while it is running reaches it at the next start.",
  },
  "not-running": {
    title: "This workspace is not running",
    detail: "Open or run the project, then come back — there is no container to connect to yet.",
  },
  "no-port": {
    title: "No port is published",
    detail:
      "The container is running but nothing is listening for SSH on it. Restarting the workspace rebuilds it with the port.",
  },
  failed: {
    title: "The workspace could not start its SSH daemon",
    detail:
      "Usually an image built before this feature existed. Rebuilding the project's image fixes it.",
  },
};

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    void message.success("Copied");
  } catch {
    // A page served over plain http has no clipboard API at all, and the
    // command is on screen to select by hand.
    void message.error("Could not copy — select the command instead");
  }
}

export function RemoteAccessDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<RemoteAccess>({
    queryKey: ["remoteAccess", projectId],
    queryFn: () => getRemoteAccessApi(projectId),
    // Only while it is on screen, and never cached across an open: the port is
    // Docker's to choose and a container that restarted has a different one, so
    // a remembered answer here is a connection refused that looks like a
    // firewall.
    enabled: open,
    staleTime: 0,
    retry: false,
  });

  return (
    <Modal
      title="Attach your own editor"
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
    >
      {isLoading ? (
        <span className="rc-skeleton" style={{ height: 80 }} aria-hidden="true" />
      ) : !data?.available ? (
        <Alert
          type="info"
          showIcon
          message={REASONS[data?.reason ?? "failed"].title}
          description={REASONS[data?.reason ?? "failed"].detail}
        />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
            This workspace accepts a connection from any key on your account.
            Your editor runs on your machine; the files, the terminal and the
            language server stay here.
          </Typography.Paragraph>

          <div
            style={{
              fontFamily: "monospace",
              fontSize: 12.5,
              background: "var(--rc-surface-sunken, rgba(127,127,127,0.12))",
              padding: "8px 10px",
              borderRadius: 6,
              overflowWrap: "anywhere",
            }}
          >
            {data.command}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Button
              onClick={() => {
                void copy(data.command ?? "");
              }}
            >
              Copy command
            </Button>
            {/* An anchor rather than a fetch: the vscode:// scheme is handled
                by the operating system, and nothing on this page can or should
                know whether it worked. */}
            <Button type="primary" href={data.vscodeUri} target="_blank">
              Open in VS Code
            </Button>
          </div>

          <Typography.Paragraph
            style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
          >
            The first connection downloads VS Code&apos;s own server (~230 MB)
            into the workspace. It is kept across restarts, so this happens once
            — and on a deployment with egress filtering on, it needs
            update.code.visualstudio.com to be allowed.
          </Typography.Paragraph>
        </div>
      )}
    </Modal>
  );
}

export default RemoteAccessDialog;
