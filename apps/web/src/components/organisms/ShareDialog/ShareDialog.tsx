import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { DeleteOutlined, LinkOutlined } from "@ant-design/icons";
import {
  createShareLinkApi,
  getAccountSecretsApi,
  getSharingApi,
  removeCollaboratorApi,
  revokeShareLinkApi,
  setCollaboratorApi,
  setProjectVisibilityApi,
  shareLinkUrl,
  type ProjectRole,
} from "../../../apis/projects.ts";
import { EmbedSection } from "./EmbedSection.tsx";

interface ShareDialogProps {
  projectId: string;
  projectName: string;
  /** Whether the project is currently readable by anybody signed in. */
  isPublic: boolean;
  /** Told when that changes, so the page around this can reflect it without
   *  refetching the whole project. */
  onVisibilityChange: (isPublic: boolean) => void;
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
  isPublic,
  onVisibilityChange,
  open,
  onClose,
}: ShareDialogProps) => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("VIEWER");

  /** How many account-wide secrets this person has, so the invite form can say
   *  what an editor would be able to read (plan.md §13.8). Never blocks the
   *  dialog: a failure here means one fewer sentence, not a share nobody can
   *  perform. */
  const { data: secrets } = useQuery({
    queryKey: ["accountSecrets"],
    queryFn: getAccountSecretsApi,
    enabled: open,
    retry: false,
  });
  const accountSecretCount = Object.keys(secrets?.vars ?? {}).length;
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

  const visibilityMutation = useMutation({
    mutationFn: (next: boolean) =>
      setProjectVisibilityApi(projectId, next ? "public" : "private"),
    onSuccess: (project) => {
      onVisibilityChange(project.visibility === "PUBLIC");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void messageApi.success(
        project.visibility === "PUBLIC"
          ? "Anyone signed in can now find this project"
          : "This project is private again",
      );
    },
    onError: (error) => {
      void messageApi.error(apiMessage(error, "Could not change that."));
    },
  });

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
            {/* First, because it is by far the broadest grant in this dialog:
                everything below names a person, and this names everybody. */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Anyone can find and fork this
                </Typography.Text>
                <Switch
                  size="small"
                  checked={isPublic}
                  loading={visibilityMutation.isPending}
                  aria-label="Make this project public"
                  onChange={(next) => {
                    visibilityMutation.mutate(next);
                  }}
                />
              </div>
              <Typography.Paragraph
                style={{
                  color: "var(--rc-text-subtle)",
                  fontSize: 12,
                  margin: "6px 0 0",
                }}
              >
                {isPublic
                  ? "Anyone signed in can read this project's files and take " +
                    "their own copy. They cannot run it, edit it, see its " +
                    "secrets, or reach its database. Forks start with no " +
                    "environment variables."
                  : "Only you and the people below can open this project."}
              </Typography.Paragraph>
            </div>

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

              {/* plan.md §13.8, and the placement is the point: it is said at
                  the moment somebody is deciding, not on a settings screen
                  they visited weeks ago. Only when they actually have account
                  secrets — a standing warning about a thing that does not
                  apply is one people learn to skip, and this has to still be
                  readable on the day it matters. */}
              {accountSecretCount > 0 && role === "EDITOR" && (
                <Typography.Text
                  type="warning"
                  style={{ fontSize: 12, display: "block", marginTop: 6 }}
                >
                  An editor can read this container&apos;s environment, which
                  includes the {accountSecretCount} account-wide{" "}
                  {accountSecretCount === 1 ? "secret" : "secrets"} you have
                  set.
                </Typography.Text>
              )}
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
