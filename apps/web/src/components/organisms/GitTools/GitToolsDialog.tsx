import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Typography,
  message,
} from "antd";
import type { GitRefComparison, GitTag } from "@replit-clone/shared";
import {
  amendCommitApi,
  cherryPickApi,
  compareRefsApi,
  createTagApi,
  deleteTagApi,
  getGitBranchesApi,
  getTagsApi,
  revertCommitApi,
} from "../../../apis/projects.ts";

/** The rest of git, for the things that are not part of the daily loop.
 *  plan.md §10.13.
 *
 *  Stash and blame are elsewhere on purpose — those two are reached for
 *  constantly and live where the work is. Tags, comparing two branches, amend,
 *  revert and cherry-pick are all deliberate, occasional acts, and a dialog is
 *  the right shape for a deliberate act: it makes you stop and name what you
 *  are doing.
 */

type Tab = "tags" | "compare" | "history";

export function GitToolsDialog({
  projectId,
  open,
  onClose,
  canWrite,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  canWrite: boolean;
}) {
  const [tab, setTab] = useState<Tab>("tags");

  return (
    <Modal
      title="Git tools"
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
      destroyOnHidden
    >
      <Segmented<Tab>
        options={[
          { label: "Tags", value: "tags" },
          { label: "Compare", value: "compare" },
          { label: "Rewrite", value: "history" },
        ]}
        value={tab}
        onChange={setTab}
        style={{ marginBottom: 14 }}
      />

      {tab === "tags" ? (
        <Tags projectId={projectId} canWrite={canWrite} />
      ) : tab === "compare" ? (
        <Compare projectId={projectId} />
      ) : (
        <Rewrite projectId={projectId} canWrite={canWrite} />
      )}
    </Modal>
  );
}

function Tags({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const { data: tags = [] } = useQuery<GitTag[]>({
    queryKey: ["tags", projectId],
    queryFn: () => getTagsApi(projectId),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createTagApi(projectId, name.trim(), note),
    onSuccess: (next) => {
      setName("");
      setNote("");
      queryClient.setQueryData(["tags", projectId], next);
      void message.success("Tagged");
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (tag: string) => deleteTagApi(projectId, tag),
    onSuccess: (next) => {
      queryClient.setQueryData(["tags", projectId], next);
    },
    onError: (error: Error) => void message.error(error.message),
  });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {canWrite && (
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            aria-label="Tag name"
            placeholder="v1.0.0"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            style={{ flex: "0 0 160px" }}
          />
          <Input
            aria-label="Tag message"
            placeholder="What this release is (optional)"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <Button
            type="primary"
            disabled={name.trim() === ""}
            loading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            Tag
          </Button>
        </div>
      )}

      {/* The distinction is worth showing rather than hiding: one is a record
          with a message and an author, the other is a bookmark. */}
      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
      >
        A message makes an annotated tag, which records who made it and when. No
        message makes a lightweight one, which is just a name for a commit.
      </Typography.Paragraph>

      {tags.length === 0 ? (
        <Empty description="No tags yet." image={null} />
      ) : (
        tags.map((tag) => (
          <div
            key={tag.name}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}
          >
            <code style={{ flex: "0 0 140px" }}>{tag.name}</code>
            <span style={{ flex: 1, color: "var(--rc-text-subtle)" }}>
              {tag.annotated ? tag.message || "annotated" : "lightweight"}
            </span>
            {canWrite && (
              <Popconfirm
                title={`Delete ${tag.name}?`}
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => {
                  remove.mutate(tag.name);
                }}
              >
                <Button size="small" danger aria-label={`Delete ${tag.name}`}>
                  Delete
                </Button>
              </Popconfirm>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function Compare({ projectId }: { projectId: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const { data: branches = [] } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => getGitBranchesApi(projectId),
    retry: false,
  });

  const compare = useMutation<GitRefComparison, Error>({
    mutationFn: () => compareRefsApi(projectId, from.trim(), to.trim()),
    onError: (error) => void message.error(error.message),
  });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Input
          aria-label="Compare from"
          placeholder="main"
          list="rc-branches"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
        <span style={{ color: "var(--rc-text-subtle)" }}>→</span>
        <Input
          aria-label="Compare to"
          placeholder="feature/x"
          list="rc-branches"
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        />
        <datalist id="rc-branches">
          {branches.map((branch) => (
            <option key={branch.name} value={branch.name} />
          ))}
        </datalist>
        <Button
          type="primary"
          disabled={from.trim() === "" || to.trim() === ""}
          loading={compare.isPending}
          onClick={() => {
            compare.mutate();
          }}
        >
          Compare
        </Button>
      </div>

      {compare.data && (
        <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
          {/* Both directions, because "ahead" alone is the half of the answer
              that makes a merge look safe when it is not. */}
          <Typography.Text>
            {compare.data.ahead.length} on {to} not on {from}, and{" "}
            {compare.data.behind.length} the other way.
          </Typography.Text>

          {compare.data.files.length === 0 ? (
            <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
              No files differ.
            </Typography.Text>
          ) : (
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {compare.data.files.map((file) => (
                <div key={file.path} style={{ display: "flex", gap: 8 }}>
                  <span style={{ flex: 1, overflowWrap: "anywhere" }}>{file.path}</span>
                  <span style={{ color: "var(--rc-added, #3fb950)" }}>+{file.added}</span>
                  <span style={{ color: "var(--rc-removed, #f85149)" }}>
                    −{file.removed}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Rewrite({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const [amendMessage, setAmendMessage] = useState("");
  const [sha, setSha] = useState("");

  const amend = useMutation({
    mutationFn: () => amendCommitApi(projectId, amendMessage.trim()),
    onSuccess: () => {
      setAmendMessage("");
      void message.success("Amended");
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const revert = useMutation({
    mutationFn: () => revertCommitApi(projectId, sha.trim()),
    onSuccess: () => void message.success("Reverted"),
    onError: (error: Error) => void message.error(error.message),
  });

  const pick = useMutation({
    mutationFn: () => cherryPickApi(projectId, sha.trim()),
    onSuccess: () => void message.success("Cherry-picked"),
    onError: (error: Error) => void message.error(error.message),
  });

  if (!canWrite) {
    return <Alert type="info" message="You have read-only access to this project." />;
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Reword the last commit
        </Typography.Text>
        {/* Said before it is refused, not after: the server checks whether the
            commit is pushed, and somebody who knows that first does not have to
            discover it as an error. */}
        <Typography.Paragraph
          style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
        >
          Refused once the commit is pushed — rewriting it then would change
          history somebody else may already have.
        </Typography.Paragraph>
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            aria-label="New commit message"
            value={amendMessage}
            onChange={(event) => {
              setAmendMessage(event.target.value);
            }}
          />
          <Button
            disabled={amendMessage.trim() === ""}
            loading={amend.isPending}
            onClick={() => {
              amend.mutate();
            }}
          >
            Amend
          </Button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Undo or copy a commit
        </Typography.Text>
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            aria-label="Commit id"
            placeholder="1a2b3c4"
            value={sha}
            onChange={(event) => {
              setSha(event.target.value);
            }}
            style={{ fontFamily: "monospace" }}
          />
          <Popconfirm
            title="Make a new commit that undoes that one?"
            okText="Revert"
            onConfirm={() => {
              revert.mutate();
            }}
          >
            <Button disabled={sha.trim() === ""} loading={revert.isPending}>
              Revert
            </Button>
          </Popconfirm>
          <Button
            disabled={sha.trim() === ""}
            loading={pick.isPending}
            onClick={() => {
              pick.mutate();
            }}
          >
            Cherry-pick
          </Button>
        </div>
        {/* Revert makes a commit; cherry-pick copies one. Stated, because the
            two words are near-synonyms in English and opposites here. */}
        <Typography.Paragraph
          style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
        >
          Revert makes a new commit undoing that one. Cherry-pick copies it onto
          this branch.
        </Typography.Paragraph>
      </div>
    </div>
  );
}

export default GitToolsDialog;
