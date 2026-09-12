import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Typography, message } from "antd";
import { VscTrash } from "react-icons/vsc";
import type { AccountSshKeys } from "@replit-clone/shared";
import { getSshKeysApi, setSshKeysApi } from "../../../apis/projects.ts";

/** Keys for attaching your own editor. plan.md §10.1 Route C.
 *
 *  Beside Identity and Secrets, and the split those two already make extends
 *  cleanly: Identity is what makes a container LOOK like your machine, Secrets
 *  is what it can REACH, and this is how YOU reach IT.
 *
 *  A paste box rather than a row editor, because the thing somebody has in
 *  their hand is the contents of `~/.ssh/id_ed25519.pub` — one long line they
 *  copied. The stored keys are listed above it with their fingerprints, which
 *  is the form somebody can check against `ssh-keygen -lf` without trusting
 *  this screen.
 */
export function SshKeys() {
  const queryClient = useQueryClient();
  const [paste, setPaste] = useState("");

  const { data, isLoading, error } = useQuery<AccountSshKeys>({
    queryKey: ["sshKeys"],
    queryFn: getSshKeysApi,
    retry: false,
  });

  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (data) setLines(data.keys.map((key) => key.line));
  }, [data]);

  const save = useMutation({
    mutationFn: (next: string[]) => setSshKeysApi(next),
    onSuccess: (next) => {
      setPaste("");
      setLines(next.keys.map((key) => key.line));
      queryClient.setQueryData(["sshKeys"], next);
      void message.success("Saved");
    },
    onError: (failure: Error) => {
      void message.error(failure.message);
    },
  });

  if (error) return <Alert type="error" message="Could not load your keys." />;

  const keys = data?.keys ?? [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
        Add a public key to open your workspaces with your own VS Code, Cursor,
        Zed or nvim over SSH. Paste the contents of a <code>.pub</code> file —
        never the private key.
      </Typography.Paragraph>

      {/* Said out loud, because a panel that accepts keys on a server which
          ignores them is a panel that lies. */}
      {data && !data.enabled && (
        <Alert
          type="warning"
          showIcon
          message="Not turned on for this server"
          description="SANDBOX_SSH_ENABLED is off, so keys added here are stored but no workspace will accept them. An operator turns it on."
        />
      )}

      {isLoading ? (
        <span className="rc-skeleton" style={{ height: 60 }} aria-hidden="true" />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {keys.length === 0 && (
            <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
              No keys yet.
            </Typography.Text>
          )}

          {keys.map((key) => (
            <div
              key={key.fingerprint}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid var(--rc-border)",
                borderRadius: 6,
                padding: "6px 8px",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{key.comment || key.type}</div>
                {/* The fingerprint rather than the key, because this is the
                    form somebody can compare against `ssh-keygen -lf` on the
                    machine the key came from. */}
                <div
                  style={{
                    fontFamily: "monospace",
                    fontSize: 11.5,
                    color: "var(--rc-text-subtle)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {key.fingerprint}
                </div>
              </div>
              <Button
                aria-label={`Remove ${key.comment || key.fingerprint}`}
                icon={<VscTrash />}
                onClick={() => {
                  save.mutate(lines.filter((line) => line !== key.line));
                }}
              />
            </div>
          ))}

          <Input.TextArea
            aria-label="New public key"
            placeholder="ssh-ed25519 AAAA... you@machine"
            rows={3}
            value={paste}
            onChange={(event) => {
              setPaste(event.target.value);
            }}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
          <div>
            <Button
              type="primary"
              loading={save.isPending}
              disabled={paste.trim() === ""}
              onClick={() => {
                // Appended to what is stored, rather than replacing it: the
                // box is for adding, and the bin icons above are for removing.
                save.mutate([...lines, ...paste.split("\n")]);
              }}
            >
              Add key
            </Button>
          </div>
        </div>
      )}

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
      >
        A key opens a shell in every workspace you own, as the sandbox user. A
        workspace already running picks up a new key when it next starts.
      </Typography.Paragraph>
    </div>
  );
}

export default SshKeys;
