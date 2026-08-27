import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { DeleteOutlined, LinkOutlined } from "@ant-design/icons";
import {
  createShareLinkApi,
  getSharingApi,
  removeCollaboratorApi,
  revokeShareLinkApi,
  setCollaboratorApi,
  shareLinkUrl,
  type ProjectRole,
} from "../../../apis/projects.ts";
import { EmbedSection } from "./EmbedSection.tsx";

interface ShareDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: "VIEWER", label: "Can view" },
  { value: "EDITOR", label: "Can edit" },
];

function apiMessage(error: unknown, fallback: string): string {
  return (
    (error as { response?: { data?: { message?: string } } }).response?.data
      ?.message ?? fallback
  );
}

/** Who else can open this project.
 *
 *  A project used to belong to exactly one person with no way to show it to
 *  anybody — not even read-only.
 */
export const ShareDialog = ({
  projectId,
  projectName,
  open,
  onClose,
}: ShareDialogProps) => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("VIEWER");
  /** What a link created from here grants. Kept separate from the email
   *  invite's role so changing one never silently changes the other. */
  const [linkRole, setLinkRole] = useState<ProjectRole>("VIEWER");

  const { data, isLoading } = useQuery({
    queryKey: ["sharing", projectId],
    queryFn: () => getSharingApi(projectId),
    enabled: open,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["sharing", projectId] });

  const addMutation = useMutation({
    mutationFn: () => setCollaboratorApi(projectId, email, role),
    onSuccess: async (added) => {
      setEmail("");
      await refresh();
      void messageApi.success(`${added.email} can now open this project`);
    },
    onError: (error) => {
      void messageApi.error(apiMessage(error, "Could not share the project."));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeCollaboratorApi(projectId, userId),
    onSuccess: refresh,
    onError: (error) => {
      void messageApi.error(apiMessage(error, "Could not remove that person."));
    },
  });

  const linkMutation = useMutation({
    mutationFn: () => createShareLinkApi(projectId, linkRole),
    onSuccess: async (token) => {
      await refresh();
      await copyLink(token);
    },
    onError: (error) => {
      void messageApi.error(apiMessage(error, "Could not create a link."));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => revokeShareLinkApi(projectId),
    onSuccess: async () => {
      await refresh();
      void messageApi.success("Link revoked. People already added keep access.");
    },
  });

  async function copyLink(token: string) {
    const url = shareLinkUrl(token);
    try {
      await navigator.clipboard.writeText(url);
      void messageApi.success("Link copied");
    } catch {
      // Clipboard access can be refused; showing the URL is the fallback that
      // still lets someone share it.
      void messageApi.info(url);
    }
  }

  const isOwner = data?.level === "owner";

  return (
    <>
      {contextHolder}

      <Modal
        open={open}
        title={`Share "${projectName}"`}
        onCancel={onClose}
        footer={
          <Button type="primary" onClick={onClose}>
            Done
          </Button>
        }
        width={560}
        destroyOnHidden
      >
        {isLoading ? (
          <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
            <Spin />
          </div>
        ) : !isOwner ? (
          <Typography.Paragraph style={{ color: "var(--rc-text-subtle)" }}>
            This project is shared with you. Only its owner can change who else
            has access.
          </Typography.Paragraph>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <Typography.Text strong style={{ fontSize: 13 }}>
                Invite by email
              </Typography.Text>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Input
                  placeholder="them@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onPressEnter={() => email.trim() && addMutation.mutate()}
                  style={{ flex: 1 }}
                />
                <Select
                  value={role}
                  onChange={setRole}
                  options={ROLE_OPTIONS}
                  style={{ width: 130 }}
                />
                <Button
                  type="primary"
                  loading={addMutation.isPending}
                  disabled={!email.trim()}
                  onClick={() => addMutation.mutate()}
                >
                  Add
                </Button>
              </div>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: "block", marginTop: 6 }}
              >
                They need an account here already. A viewer can read files and
                watch the preview but cannot edit, run, or open a terminal.
              </Typography.Text>
            </div>

            {data.collaborators.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.collaborators.map((person) => (
                  <div
                    key={person.userId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 0",
                      borderBottom: "1px solid var(--rc-border)",
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
                      {person.email}
                    </span>
                    <Select
                      size="small"
                      value={person.role}
                      options={ROLE_OPTIONS}
                      style={{ width: 120 }}
                      onChange={(next) => {
                        setEmail(person.email);
                        setRole(next);
                        setCollaboratorApi(projectId, person.email, next)
                          .then(refresh)
                          .catch(() => {
                            void messageApi.error("Could not change that role.");
                          });
                      }}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      aria-label={`Remove ${person.email}`}
                      icon={<DeleteOutlined />}
                      onClick={() => removeMutation.mutate(person.userId)}
                    />
                  </div>
                ))}
              </div>
            )}

            <div>
              <Typography.Text strong style={{ fontSize: 13 }}>
                Share by link
              </Typography.Text>

              <div
                style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}
              >
                {data.shareToken ? (
                  <>
                    <Tag color={data.shareRole === "EDITOR" ? "orange" : "green"}>
                      {data.shareRole === "EDITOR" ? "Link grants edit" : "Link grants view"}
                    </Tag>
                    <Button
                      size="small"
                      icon={<LinkOutlined />}
                      onClick={() => void copyLink(data.shareToken ?? "")}
                    >
                      Copy
                    </Button>
                    {/* Creating a new link silently breaking the old one would
                        be a nasty surprise, so it asks. */}
                    <Popconfirm
                      title="Replace the link?"
                      description="Anyone holding the current link loses access."
                      okText="Replace"
                      onConfirm={() => linkMutation.mutate()}
                    >
                      <Button size="small">New link</Button>
                    </Popconfirm>
                    {/* The role chosen here is what the REPLACEMENT grants; the
                        tag shows what the current one grants. */}
                    <Select
                      size="small"
                      value={linkRole}
                      onChange={setLinkRole}
                      options={ROLE_OPTIONS}
                      style={{ width: 120 }}
                    />
                    <Button
                      size="small"
                      danger
                      loading={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate()}
                    >
                      Revoke
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      icon={<LinkOutlined />}
                      loading={linkMutation.isPending}
                      onClick={() => linkMutation.mutate()}
                    >
                      Create link
                    </Button>
                    <Select
                      size="small"
                      value={linkRole}
                      onChange={setLinkRole}
                      options={ROLE_OPTIONS}
                      style={{ width: 120 }}
                    />
                  </>
                )}
              </div>

              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: "block", marginTop: 6 }}
              >
                Anyone signed in who opens the link is added with the role shown.
                Revoking it stops new people joining; those already added keep
                their access and can be removed or demoted below.
              </Typography.Text>
            </div>

            {/* Last, and separated, because it is a different decision from
                everything above it: the two controls above invite named people
                here, this one publishes the source into somebody else's page. */}
            <EmbedSection
              projectId={projectId}
              projectName={projectName}
              enabled={open}
              isOwner={isOwner}
            />
          </div>
        )}
      </Modal>
    </>
  );
};
