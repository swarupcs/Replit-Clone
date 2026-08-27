import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Popconfirm, Select, Tag, Typography, message } from "antd";
import { CodeOutlined } from "@ant-design/icons";
import type { EmbedPreview, EmbedView } from "@replit-clone/shared";
import {
  createProjectEmbedApi,
  embedSnippet,
  embedUrl,
  getProjectEmbedApi,
  revokeProjectEmbedApi,
  updateProjectEmbedApi,
} from "../../../apis/embeds.ts";

interface EmbedSectionProps {
  projectId: string;
  projectName: string;
  enabled: boolean;
  isOwner: boolean;
}

const VIEW_OPTIONS: { value: EmbedView; label: string }[] = [
  { value: "split", label: "Code and preview" },
  { value: "code", label: "Code only" },
  { value: "preview", label: "Preview only" },
];

const PREVIEW_OPTIONS: { value: EmbedPreview; label: string }[] = [
  { value: "deployment", label: "The published site" },
  { value: "none", label: "Nothing" },
];

/** Putting this project in somebody else's page.
 *
 *  Presented as its own thing rather than a third kind of share link, because
 *  it is a different decision: a share link invites a named person to come
 *  here, an embed publishes the source to everybody who reads an article. The
 *  copy says so plainly — this is the control most likely to be used without
 *  its consequences being thought through.
 */
export const EmbedSection = ({
  projectId,
  projectName,
  enabled,
  isOwner,
}: EmbedSectionProps) => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();

  const { data } = useQuery({
    queryKey: ["embed", projectId],
    queryFn: () => getProjectEmbedApi(projectId),
    enabled,
  });

  const [view, setView] = useState<EmbedView | null>(null);
  const [preview, setPreview] = useState<EmbedPreview | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["embed", projectId] });

  const chosenView = view ?? data?.settings.view ?? "split";
  const chosenPreview = preview ?? data?.settings.preview ?? "deployment";

  const createMutation = useMutation({
    mutationFn: () =>
      createProjectEmbedApi(projectId, {
        view: chosenView,
        preview: chosenPreview,
      }),
    onSuccess: async (state) => {
      await refresh();
      if (state.token) await copySnippet(state.token);
    },
    onError: () => {
      void messageApi.error("Could not create an embed.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (settings: { view?: EmbedView; preview?: EmbedPreview }) =>
      updateProjectEmbedApi(projectId, settings),
    onSuccess: refresh,
  });

  const revokeMutation = useMutation({
    mutationFn: () => revokeProjectEmbedApi(projectId),
    onSuccess: async () => {
      await refresh();
      void messageApi.success("Embed revoked.");
    },
  });

  async function copySnippet(token: string) {
    const snippet = embedSnippet(
      embedUrl(token, { view: chosenView }),
      projectName,
    );

    try {
      await navigator.clipboard.writeText(snippet);
      void messageApi.success("Snippet copied");
    } catch {
      // Refused clipboard access is common in an iframe and not rare outside
      // one. Showing the snippet still lets somebody use it.
      void messageApi.info(snippet);
    }
  }

  if (!isOwner) return null;

  return (
    <div>
      {contextHolder}

      <Typography.Text strong style={{ fontSize: 13 }}>
        Embed in a page
      </Typography.Text>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <Select
          size="small"
          value={chosenView}
          options={VIEW_OPTIONS}
          style={{ width: 170 }}
          onChange={(next) => {
            setView(next);
            if (data?.token) updateMutation.mutate({ view: next });
          }}
        />
        <Select
          size="small"
          value={chosenPreview}
          options={PREVIEW_OPTIONS}
          style={{ width: 165 }}
          onChange={(next) => {
            setPreview(next);
            if (data?.token) updateMutation.mutate({ preview: next });
          }}
        />

        {data?.token ? (
          <>
            <Button
              size="small"
              icon={<CodeOutlined />}
              onClick={() => void copySnippet(data.token ?? "")}
            >
              Copy snippet
            </Button>
            {/* Asks, because the old snippet is already in pages this owner
                may not be able to edit. */}
            <Popconfirm
              title="Replace the embed?"
              description="Pages carrying the current snippet stop working."
              okText="Replace"
              onConfirm={() => createMutation.mutate()}
            >
              <Button size="small">New</Button>
            </Popconfirm>
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
          <Button
            size="small"
            icon={<CodeOutlined />}
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Create embed
          </Button>
        )}
      </div>

      {data?.token && (
        <Input.TextArea
          readOnly
          value={embedSnippet(
            embedUrl(data.token, { view: chosenView }),
            projectName,
          )}
          autoSize={{ minRows: 3, maxRows: 5 }}
          onFocus={(event) => {
            event.target.select();
          }}
          style={{
            marginTop: 8,
            fontFamily: "var(--rc-mono)",
            fontSize: 11.5,
          }}
        />
      )}

      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, display: "block", marginTop: 6 }}
      >
        Anyone who can see the page can read every file in this project, with no
        account and no sign-in. Nobody can edit, run anything, or open a
        terminal through it.
      </Typography.Text>

      {chosenPreview === "deployment" && data && !data.hasDeployment && (
        <Typography.Text
          type="warning"
          style={{ fontSize: 12, display: "block", marginTop: 4 }}
        >
          This project has not been deployed, so the preview half will be empty
          until it is.
        </Typography.Text>
      )}

      {data && data.hiddenPaths.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Never shown, because these usually hold secrets:
          </Typography.Text>{" "}
          {data.hiddenPaths.map((path) => (
            <Tag key={path} style={{ fontSize: 11, marginInlineEnd: 4 }}>
              {path}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
};
