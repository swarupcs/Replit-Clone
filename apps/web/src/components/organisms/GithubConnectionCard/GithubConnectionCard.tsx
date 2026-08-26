import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Spin, Typography } from "antd";
import { VscGithub } from "react-icons/vsc";
import {
  disconnectGithubApi,
  getGithubStatusApi,
  startGithubConnectApi,
} from "../../../apis/github.ts";
import { navigateAway } from "../../../lib/navigateAway.ts";

interface GithubConnectionCardProps {
  open: boolean;
  onClose: () => void;
}

/** Connecting a GitHub account so this server can act on the user's behalf.
 *
 *  Deliberately separate from signing in with GitHub. That grants
 *  `read:user user:email` and is enough to say who you are; this grants `repo`,
 *  which can read and rewrite every repository you can. Nobody is made to give
 *  the second in order to get the first.
 */
export const GithubConnectionCard = ({
  open,
  onClose,
}: GithubConnectionCardProps) => {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["github", "status"],
    queryFn: getGithubStatusApi,
    // Only while the dialog is up: the answer changes on a round trip through
    // GitHub, not on its own.
    enabled: open,
  });

  const connect = useMutation({
    mutationFn: startGithubConnectApi,
    // Wrapped rather than passed directly: react-query hands a success handler
    // the variables and a context beside the data, and `navigateAway` takes one
    // argument.
    onSuccess: (url) => {
      navigateAway(url);
    },
  });

  const disconnect = useMutation({
    mutationFn: disconnectGithubApi,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["github"] }),
  });

  const connection = data?.connection ?? null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <VscGithub size={17} />
          GitHub
        </span>
      }
      footer={<Button onClick={onClose}>Done</Button>}
      destroyOnHidden
    >
      {/* Nothing decisive until the answer is in. Rendering the "not connected"
          copy while the query is still out states something the app does not
          yet know, and it was showing that copy under a button that could not
          be clicked. */}
      {isLoading || !data ? (
        <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : data.configured === false ? (
        <Alert
          type="info"
          showIcon
          message="Not configured on this server"
          description={
            "Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and " +
            "SECRET_ENCRYPTION_KEY to enable importing and pushing."
          }
        />
      ) : connection ? (
        <>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            Connected as <b>{connection.login}</b>.
          </Typography.Paragraph>

          {!connection.canUseRepos && (
            // GitHub granted less than was asked for, which an organisation can
            // do. Said here rather than left to fail at the first import.
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="No repository access was granted"
              description={
                "Importing and pushing need the repo scope. Reconnect, and " +
                "approve access for the organisation that owns the repository."
              }
            />
          )}

          <Typography.Paragraph
            style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}
          >
            The token is stored encrypted and is only ever used by this server
            on your behalf. Disconnecting deletes it.
          </Typography.Paragraph>

          <div style={{ display: "flex", gap: 8 }}>
            <Button
              danger
              loading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
            <Button
              loading={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Reconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <Typography.Paragraph>
            Connect GitHub to import a repository, push, and open pull requests
            without pasting a token each time.
          </Typography.Paragraph>
          <Typography.Paragraph
            style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}
          >
            This is separate from signing in with GitHub, and asks for more:
            access to your repositories. The token is stored encrypted, is never
            sent to your browser, and disconnecting deletes it.
          </Typography.Paragraph>

          <Button
            type="primary"
            icon={<VscGithub />}
            loading={connect.isPending}
            onClick={() => connect.mutate()}
          >
            Connect GitHub
          </Button>
        </>
      )}
    </Modal>
  );
};
