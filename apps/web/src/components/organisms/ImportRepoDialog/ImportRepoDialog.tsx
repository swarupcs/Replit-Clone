import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Modal, Spin, Typography } from "antd";
import { VscGithub, VscLock, VscRepo } from "react-icons/vsc";
import type { GithubRepo, Project } from "@replit-clone/shared";
import {
  getGithubStatusApi,
  importGithubRepoApi,
  listGithubReposApi,
} from "../../../apis/github.ts";

interface ImportRepoDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (project: Project) => void;
  /** Opens the connection dialog, for the case where there is nothing to
   *  import with yet. */
  onConnect: () => void;
}

/** Wait after the last keystroke before searching, so typing a repository name
 *  does not spend a GitHub API call per character. The same 300ms the project
 *  search uses. */
const DEBOUNCE_MS = 300;

function reasonFrom(error: unknown, fallback: string): string {
  const body = (error as { response?: { data?: { message?: unknown } } }).response
    ?.data;
  if (typeof body?.message === "string" && body.message) return body.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

export const ImportRepoDialog = ({
  open,
  onClose,
  onImported,
  onConnect,
}: ImportRepoDialogProps) => {
  const queryClient = useQueryClient();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  /** Which repository is being cloned, so the row can say so rather than the
   *  whole dialog going blank. */
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const status = useQuery({
    queryKey: ["github", "status"],
    queryFn: getGithubStatusApi,
    enabled: open,
  });

  const connected = Boolean(status.data?.connection?.canUseRepos);

  const repos = useQuery({
    queryKey: ["github", "repos", debounced],
    queryFn: () => listGithubReposApi(debounced ? { query: debounced } : {}),
    // Only once there is something to list with: asking otherwise is a
    // guaranteed 400 and a confusing error.
    enabled: open && connected,
  });

  const importRepo = useMutation({
    mutationFn: importGithubRepoApi,
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onImported(project);
    },
    onError: (failure: unknown) => {
      setError(reasonFrom(failure, "Could not import that repository."));
    },
    onSettled: () => setImporting(null),
  });

  function start(repo: GithubRepo) {
    setError(null);
    setImporting(repo.fullName);
    importRepo.mutate({ owner: repo.owner, repo: repo.name });
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={620}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <VscGithub size={17} />
          Import from GitHub
        </span>
      }
      footer={<Button onClick={onClose}>Cancel</Button>}
      destroyOnHidden
    >
      {status.isLoading ? (
        <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
          <Spin />
        </div>
      ) : !connected ? (
        <Alert
          type="info"
          showIcon
          message="Connect GitHub first"
          description={
            <>
              <div style={{ marginBottom: 10 }}>
                Importing needs access to your repositories, which is a separate
                permission from signing in.
              </div>
              <Button type="primary" size="small" onClick={onConnect}>
                Connect GitHub
              </Button>
            </>
          }
        />
      ) : (
        <>
          <Input
            allowClear
            placeholder="Search your repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ marginBottom: 12 }}
          />

          {error && (
            <Alert
              type="error"
              showIcon
              closable
              message={error}
              onClose={() => setError(null)}
              style={{ marginBottom: 12 }}
            />
          )}

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {repos.isLoading ? (
              <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
                <Spin />
              </div>
            ) : repos.data?.repos.length ? (
              repos.data.repos.map((repo) => (
                <div
                  key={repo.id}
                  className="rc-tree-row"
                  style={{ cursor: "default", alignItems: "flex-start", gap: 10 }}
                >
                  <span style={{ display: "flex", marginTop: 3, flex: "none" }}>
                    {repo.private ? <VscLock size={13} /> : <VscRepo size={13} />}
                  </span>

                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13 }}>
                      {repo.fullName}
                    </span>
                    {repo.description && (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11.5,
                          color: "var(--rc-text-subtle)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {repo.description}
                      </span>
                    )}
                  </span>

                  <Button
                    size="small"
                    // Only the row being cloned spins; the rest stay clickable
                    // right up until one is.
                    loading={importing === repo.fullName}
                    disabled={importing !== null && importing !== repo.fullName}
                    onClick={() => start(repo)}
                  >
                    Import
                  </Button>
                </div>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  debounced
                    ? `No repositories match “${debounced}”`
                    : "No repositories found"
                }
              />
            )}
          </div>

          <Typography.Paragraph
            style={{
              marginTop: 12,
              marginBottom: 0,
              fontSize: 12,
              color: "var(--rc-text-subtle)",
            }}
          >
            The default branch is cloned. Large repositories may take a moment.
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
};
