import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Popconfirm,
  Tag,
  Typography,
  message,
} from "antd";
import {
  API_KEY_SCOPES,
  MAX_KEY_LABEL,
  SCOPE_LABEL,
  type ApiKeyScope,
  type ApiKeySummary,
} from "@replit-clone/shared";
import {
  createApiKeyApi,
  listApiKeysApi,
  revokeApiKeyApi,
} from "../../../apis/projects.ts";

/** Credentials for things that are not people.
 *
 *  Two things this screen has to get right, and both are about the moment a
 *  key is created rather than about the list. The secret is shown once and is
 *  not recoverable, so it has to be unmissable and it has to stay on screen
 *  until it is dismissed. And the scopes have to be chosen deliberately, which
 *  is why nothing is ticked by default: a form that pre-selects everything
 *  teaches people to click through it.
 */

function used(key: ApiKeySummary): string {
  if (key.revokedAt) return `Revoked ${new Date(key.revokedAt).toLocaleDateString()}`;
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) return "Expired";
  if (!key.lastUsedAt) return "Never used";
  return `Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`;
}

function isLive(key: ApiKeySummary): boolean {
  if (key.revokedAt) return false;
  return !key.expiresAt || new Date(key.expiresAt) > new Date();
}

export const ApiKeys = () => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: keys, isLoading, error } = useQuery({
    queryKey: ["api-keys"],
    queryFn: listApiKeysApi,
    retry: false,
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });

  const create = useMutation({
    mutationFn: () => createApiKeyApi({ label: label.trim(), scopes }),
    onSuccess: (created) => {
      // Held in state rather than in a toast: a secret that vanishes after
      // three seconds is a secret somebody has to come back and re-mint.
      setSecret(created.secret);
      setLabel("");
      setScopes([]);
      setCreating(false);
      refresh();
    },
    onError: (mutationError) => {
      void messageApi.error(
        (mutationError as { response?: { data?: { message?: string } } })
          .response?.data?.message ?? "Could not create that key.",
      );
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => revokeApiKeyApi(keyId),
    onSuccess: () => {
      refresh();
      void messageApi.success("Key revoked.");
    },
    onError: () => {
      void messageApi.error("Could not revoke that key.");
    },
  });

  if (error) {
    return <Empty description="Could not load this account's API keys." />;
  }

  return (
    <>
      {contextHolder}

      {secret && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message="Copy this now"
          description={
            <>
              <Typography.Paragraph style={{ fontSize: 12.5, marginBottom: 6 }}>
                This is the only time it will be shown. The server keeps a hash
                of it, so it cannot be shown again — if you lose it, revoke it
                and make another.
              </Typography.Paragraph>
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {secret}
              </Typography.Text>
            </>
          }
          closable
          onClose={() => setSecret(null)}
        />
      )}

      {isLoading ? (
        <div aria-label="Loading API keys" style={{ display: "grid", gap: 8 }}>
          <span className="rc-skeleton" style={{ height: 30 }} aria-hidden="true" />
        </div>
      ) : (keys ?? []).length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No keys yet."
        />
      ) : (
        <ul
          aria-label="API keys"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
        >
          {keys?.map((key) => (
            <li key={key.id} className="rc-card" style={{ padding: 10 }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <Typography.Text strong style={{ fontSize: 13.5 }}>
                  {key.label}
                </Typography.Text>
                <Typography.Text code style={{ fontSize: 11.5 }}>
                  {key.prefix}…
                </Typography.Text>
                {key.scopes.map((scope) => (
                  <Tag key={scope}>{SCOPE_LABEL[scope]}</Tag>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 6,
                }}
              >
                <Typography.Text
                  style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}
                >
                  {used(key)}
                </Typography.Text>
                {isLive(key) && (
                  <Popconfirm
                    title="Revoke this key?"
                    description="Anything using it stops working immediately."
                    okText="Revoke"
                    onConfirm={() => {
                      revoke.mutate(key.id);
                    }}
                  >
                    <Button size="small" danger>
                      Revoke
                    </Button>
                  </Popconfirm>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <div className="rc-card" style={{ padding: 12, marginTop: 10 }}>
          <Input
            aria-label="Key name"
            placeholder="What is it for?"
            maxLength={MAX_KEY_LABEL}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
          <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
            {/* Nothing is ticked by default. A form that pre-selects
                everything teaches people to click through it, and this is the
                screen where that matters most. */}
            {API_KEY_SCOPES.map((scope) => (
              <Checkbox
                key={scope}
                checked={scopes.includes(scope)}
                onChange={(event) => {
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  );
                }}
              >
                {SCOPE_LABEL[scope]}
              </Checkbox>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button
              type="primary"
              size="small"
              loading={create.isPending}
              disabled={label.trim().length === 0 || scopes.length === 0}
              onClick={() => {
                create.mutate();
              }}
            >
              Create key
            </Button>
            <Button size="small" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="small"
          style={{ marginTop: 10 }}
          onClick={() => setCreating(true)}
        >
          New key
        </Button>
      )}

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginTop: 10 }}
      >
        A key reaches a deliberately small part of this platform: listing
        projects, creating one, and publishing. It cannot delete anything,
        cannot read your environment variables, and cannot make another key.
      </Typography.Paragraph>
    </>
  );
};

export default ApiKeys;
