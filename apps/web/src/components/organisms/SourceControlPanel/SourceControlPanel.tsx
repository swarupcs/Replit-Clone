import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Spin, Tooltip, message } from "antd";
import {
  VscAdd,
  VscCheck,
  VscHistory,
  VscRefresh,
  VscRemove,
  VscSourceControl,
} from "react-icons/vsc";
import type { GitChange, GitCommit, GitStatus } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { DiffView } from "./DiffView.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import {
  getGitLogApi,
  getGitStatusApi,
  gitCommitApi,
  gitInitApi,
  gitStageApi,
  gitUnstageApi,
} from "../../../apis/projects.ts";

/** One letter per state, the way every git UI abbreviates them. */
const BADGE: Record<string, { letter: string; colour: string; title: string }> =
  {
    added: { letter: "A", colour: "#4ade80", title: "Added" },
    modified: { letter: "M", colour: "#fbbf24", title: "Modified" },
    deleted: { letter: "D", colour: "#f87171", title: "Deleted" },
    renamed: { letter: "R", colour: "#a78bfa", title: "Renamed" },
    untracked: { letter: "U", colour: "#60a5fa", title: "Untracked" },
  };

interface Props {
  projectId: string;
  /** False for a viewer, who may read history but not change the repository. */
  canWrite: boolean;
}

/** Source control for the project's own repository.
 *
 *  Clicking a changed file expands its diff in place; the row's icon still
 *  opens the file for editing.
 *
 *  Staging is per file rather than per hunk. Hunk-level staging needs a patch
 *  editor to be worth anything, and half of one is worse than none.
 */
export function SourceControlPanel({ projectId, canWrite }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [messageText, setMessageText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  /** Which row's diff is open, as `"s"|"u":path` -- the same key the rows use,
   *  so the staged and unstaged entries for one file expand independently. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const next = await getGitStatusApi(projectId);
        setStatus(next);
        if (next.isRepo) setCommits(await getGitLogApi(projectId, 20));
      } catch {
        // A project whose container will not start should not spam the panel;
        // the empty state below already says the repository is unavailable.
        setStatus(null);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The tree already broadcasts when files change on disk, and every one of
  // those is a change git would report differently. Reusing it keeps the panel
  // current without polling.
  useEffect(() => {
    if (!editorSocket) return;
    const onTreeChanged = () => void refresh(true);
    editorSocket.on("treeChanged", onTreeChanged);
    return () => {
      editorSocket.off("treeChanged", onTreeChanged);
    };
  }, [editorSocket, refresh]);

  const { staged, unstaged } = useMemo(() => {
    const changes = status?.changes ?? [];
    return {
      staged: changes.filter((change) => change.staged),
      unstaged: changes.filter((change) => change.unstaged),
    };
  }, [status]);

  const act = async (work: () => Promise<GitStatus>, failure: string) => {
    setBusy(true);
    try {
      setStatus(await work());
    } catch (error) {
      const detail =
        error instanceof Error && error.message ? error.message : failure;
      void message.error(detail);
    } finally {
      setBusy(false);
    }
  };

  const openFile = (relPath: string) => {
    editorSocket?.emit("readFile", { relPath });
  };

  const onCommit = async () => {
    const text = messageText.trim();
    if (!text) return;

    setBusy(true);
    try {
      const result = await gitCommitApi(projectId, text);
      setStatus(result.status);
      setCommits(result.commits);
      setMessageText("");
      void message.success("Committed");
    } catch (error) {
      void message.error(
        error instanceof Error && error.message ? error.message : "Commit failed",
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (!status) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Source control is unavailable"
        style={{ marginTop: 32 }}
      />
    );
  }

  if (!status.isRepo) {
    return (
      <div style={{ padding: 16, textAlign: "center" }}>
        <VscSourceControl size={28} style={{ opacity: 0.5 }} />
        <p style={{ margin: "12px 0", fontSize: 12, opacity: 0.7 }}>
          This project has no repository yet.
        </p>
        {canWrite && (
          <Button
            size="small"
            loading={busy}
            onClick={() =>
              void act(() => gitInitApi(projectId), "Could not initialise")
            }
          >
            Initialise repository
          </Button>
        )}
      </div>
    );
  }

  const row = (change: GitChange, isStaged: boolean) => {
    const state = isStaged ? change.staged : change.unstaged;
    const badge = state ? BADGE[state] : undefined;
    const name = change.path.split("/").pop() ?? change.path;
    const key = `${isStaged ? "s" : "u"}:${change.path}`;
    const isOpen = expanded === key;

    return (
      <div key={key}>
      <div
        className="rc-tree-row"
        data-active={isOpen}
        onClick={() => {
          // The row shows the change; opening the file for editing is what the
          // icon is for. Clicking an open row closes it again.
          setExpanded(isOpen ? null : key);
        }}
        title={change.from ? `${change.from} → ${change.path}` : change.path}
      >
        <span
          role="button"
          tabIndex={-1}
          title={`Open ${name}`}
          style={{ display: "flex", alignItems: "center" }}
          onClick={(event) => {
            event.stopPropagation();
            openFile(change.path);
          }}
        >
          <FileIcon extension={fileExtension(change.path)} name={name} />
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontSize: 11,
            opacity: 0.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 90,
          }}
        >
          {change.path.includes("/")
            ? change.path.slice(0, change.path.lastIndexOf("/"))
            : ""}
        </span>

        {canWrite && (
          <Tooltip title={isStaged ? "Unstage" : "Stage"}>
            <button
              type="button"
              className="rc-icon-button"
              disabled={busy}
              onClick={(event) => {
                // The row itself opens the file, which is not what a click on
                // this button means.
                event.stopPropagation();
                void act(
                  () =>
                    isStaged
                      ? gitUnstageApi(projectId, [change.path])
                      : gitStageApi(projectId, [change.path]),
                  isStaged ? "Could not unstage" : "Could not stage",
                );
              }}
            >
              {isStaged ? <VscRemove size={13} /> : <VscAdd size={13} />}
            </button>
          </Tooltip>
        )}

        {badge && (
          <span
            title={badge.title}
            style={{
              color: badge.colour,
              fontSize: 11,
              fontWeight: 700,
              width: 12,
              textAlign: "center",
            }}
          >
            {badge.letter}
          </span>
        )}
      </div>

      {isOpen && (
        <DiffView projectId={projectId} path={change.path} staged={isStaged} />
      )}
      </div>
    );
  };

  const section = (
    label: string,
    items: GitChange[],
    isStaged: boolean,
    action?: { title: string; icon: React.ReactNode; run: () => void },
  ) =>
    items.length > 0 && (
      <div style={{ marginBottom: 8 }}>
        <div
          className="rc-pane-label"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
          }}
        >
          <span style={{ flex: 1 }}>
            {label} ({items.length})
          </span>
          {canWrite && action && (
            <Tooltip title={action.title}>
              <button
                type="button"
                className="rc-icon-button"
                disabled={busy}
                onClick={action.run}
              >
                {action.icon}
              </button>
            </Tooltip>
          )}
        </div>
        {items.map((change) => row(change, isStaged))}
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
        }}
      >
        <span style={{ fontSize: 12, opacity: 0.75, flex: 1 }}>
          {status.branch ?? "HEAD"}
          {status.unborn ? " · no commits yet" : ""}
        </span>
        <Tooltip title="History">
          <button
            type="button"
            className="rc-icon-button"
            data-on={showHistory}
            onClick={() => {
              setShowHistory((value) => !value);
            }}
          >
            <VscHistory size={14} />
          </button>
        </Tooltip>
        <Tooltip title="Refresh">
          <button
            type="button"
            className="rc-icon-button"
            onClick={() => void refresh()}
          >
            <VscRefresh size={14} />
          </button>
        </Tooltip>
      </div>

      {canWrite && (
        <div style={{ padding: "0 8px 8px" }}>
          <Input.TextArea
            value={messageText}
            onChange={(event) => {
              setMessageText(event.target.value);
            }}
            placeholder="Message"
            autoSize={{ minRows: 2, maxRows: 6 }}
            style={{ fontSize: 13 }}
            onKeyDown={(event) => {
              // Ctrl+Enter commits, as it does in every editor's commit box.
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void onCommit();
              }
            }}
          />
          <Button
            block
            size="small"
            type="primary"
            icon={<VscCheck size={13} />}
            style={{ marginTop: 6 }}
            loading={busy}
            disabled={staged.length === 0 || !messageText.trim()}
            onClick={() => void onCommit()}
          >
            Commit {staged.length > 0 ? `(${staged.length})` : ""}
          </Button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }}>
        {showHistory ? (
          commits.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No commits yet"
              style={{ marginTop: 24 }}
            />
          ) : (
            commits.map((entry) => (
              <div
                key={entry.hash}
                className="rc-tree-row"
                title={`${entry.hash}\n${entry.author}\n${entry.date}`}
              >
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.subject}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>
                    {entry.shortHash} · {entry.author}
                  </div>
                </div>
              </div>
            ))
          )
        ) : (
          <>
            {section("Staged", staged, true, {
              title: "Unstage all",
              icon: <VscRemove size={13} />,
              run: () => {
                void act(
                  () =>
                    gitUnstageApi(
                      projectId,
                      staged.map((change) => change.path),
                    ),
                  "Could not unstage",
                );
              },
            })}
            {section("Changes", unstaged, false, {
              title: "Stage all",
              icon: <VscAdd size={13} />,
              run: () => {
                void act(
                  () =>
                    gitStageApi(
                      projectId,
                      unstaged.map((change) => change.path),
                    ),
                  "Could not stage",
                );
              },
            })}
            {staged.length === 0 && unstaged.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No changes"
                style={{ marginTop: 24 }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
