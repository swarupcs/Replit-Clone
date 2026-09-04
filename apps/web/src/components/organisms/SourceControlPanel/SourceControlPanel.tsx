import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Spin,
  Tooltip,
  message,
} from "antd";
import {
  VscAdd,
  VscCheck,
  VscHistory,
  VscRefresh,
  VscCloud,
  VscGithub,
  VscDiscard,
  VscRemove,
  VscSourceControl,
  VscSync,
} from "react-icons/vsc";
import type {
  GitBranch,
  GitRemote,
  GitChange,
  GitCommit,
  GitStatus,
} from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { DiffView } from "./DiffView.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { getGithubStatusApi } from "../../../apis/github.ts";
import type { GithubPullRequest } from "@replit-clone/shared";
import {
  getGitBranchesApi,
  getGitLogApi,
  getGitStatusApi,
  gitBranchApi,
  gitDiscardApi,
  gitFetchApi,
  gitHunksApi,
  gitPullApi,
  gitPushApi,
  gitSyncApi,
  getGithubPullsApi,
  createGithubPullApi,
  getGithubProjectRepoApi,
  getGitRemotesApi,
  gitCommitApi,
  gitInitApi,
  gitStageApi,
  gitUnstageApi,
} from "../../../apis/projects.ts";

/** One letter per state, the way every git UI abbreviates them. */
const BADGE: Record<string, { letter: string; colour: string; title: string }> =
  {
    added: { letter: "A", colour: "var(--rc-green)", title: "Added" },
    modified: { letter: "M", colour: "var(--rc-yellow)", title: "Modified" },
    deleted: { letter: "D", colour: "var(--rc-red)", title: "Deleted" },
    renamed: { letter: "R", colour: "var(--rc-accent)", title: "Renamed" },
    untracked: { letter: "U", colour: "var(--rc-info, #2563eb)", title: "Untracked" },
  };

interface Props {
  projectId: string;
  /** False for a viewer, who may read history but not change the repository. */
  canWrite: boolean;
  /** Pushing spends the owner's own credential, so only they are offered it. */
  isOwner: boolean;
}

/** Source control for the project's own repository.
 *
 *  Clicking a changed file expands its diff in place; the row's icon still
 *  opens the file for editing.
 *
 *  Staging is per file rather than per hunk. Hunk-level staging needs a patch
 *  editor to be worth anything, and half of one is worse than none.
 */
export function SourceControlPanel({ projectId, canWrite, isOwner }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [messageText, setMessageText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  /** Which row's diff is open, as `"s"|"u":path` -- the same key the rows use,
   *  so the staged and unstaged entries for one file expand independently. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const [branches, setBranches] = useState<GitBranch[]>([]);
  /** Non-null while the "new branch" dialog is open, holding the typed name. */
  const [newBranch, setNewBranch] = useState<string | null>(null);

  /** The change awaiting a discard confirmation. Held rather than acted on,
   *  because discarding is not undoable. */
  const [discarding, setDiscarding] = useState<GitChange | null>(null);

  /** Bumped after a hunk moves, so the open diff re-fetches: its props have
   *  not changed but the patch it is showing has. */
  const [hunkNonce, setHunkNonce] = useState(0);

  const [remotes, setRemotes] = useState<GitRemote[]>([]);

  /** The remote a push is being set up for, and the token typed for it.
   *
   *  Held in component state for the length of the dialog and cleared the
   *  moment it closes -- never put in a store, localStorage or a URL. */
  const [pushingTo, setPushingTo] = useState<string | null>(null);
  const [pushToken, setPushToken] = useState("");
  /** Whether a connected GitHub account can supply the credential, so the
   *  dialog can stop asking for one. Null until the answer is in — the dialog
   *  must not offer to push with a connection it does not yet know about. */
  const [canUseConnection, setCanUseConnection] = useState<boolean | null>(null);
  /** Open, when the pull request dialog is up. */
  const [openingPull, setOpeningPull] = useState(false);
  const [pullTitle, setPullTitle] = useState("");
  const [pullBody, setPullBody] = useState("");
  const [pullBase, setPullBase] = useState("");
  /** A pull request that already exists for this branch, so the panel offers
   *  the link instead of a second attempt that GitHub would refuse. */
  const [existingPull, setExistingPull] = useState<GithubPullRequest | null>(null);
  /** The GitHub repository this project's remotes point at, or null when they
   *  point somewhere else — which is how the panel knows not to offer a pull
   *  request rather than offering one that cannot work. */
  const [githubRepo, setGithubRepo] = useState<
    { owner: string; repo: string; url: string } | null
  >(null);

  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const next = await getGitStatusApi(projectId);
        setStatus(next);
        if (next.isRepo) {
          setCommits(await getGitLogApi(projectId, 20));
          setBranches(await getGitBranchesApi(projectId));
          setRemotes(await getGitRemotesApi(projectId));
        }
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

  // Re-asked whenever the remotes change, since adding one is what turns a
  // local project into a GitHub one.
  useEffect(() => {
    let cancelled = false;

    void getGithubProjectRepoApi(projectId)
      .then((found) => {
        if (!cancelled) setGithubRepo(found);
      })
      .catch(() => {
        if (!cancelled) setGithubRepo(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, remotes]);

  // Asked once, and only by the owner: nobody else is offered pushing, so
  // nobody else needs to know whether a credential could be supplied.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;

    void getGithubStatusApi()
      .then((github) => {
        if (!cancelled) {
          setCanUseConnection(Boolean(github.connection?.canUseRepos));
        }
      })
      // A deployment without GitHub configured answers this with an error, and
      // that is not a failure worth reporting — it just means the box stays.
      .catch(() => {
        if (!cancelled) setCanUseConnection(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOwner]);

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

  /** The server's own message, when it sent one.
   *
   *  Axios turns a 400 into "Request failed with status code 400", which tells
   *  the user nothing -- and git's refusals are the cases where the reason IS
   *  the useful part ("commit or discard your changes before switching
   *  branch"). The API always answers a failure with `{ message }`.
   */
  const reasonFrom = (error: unknown, fallback: string): string => {
    const body = (error as { response?: { data?: { message?: unknown } } })
      .response?.data;

    if (typeof body?.message === "string" && body.message) return body.message;
    return error instanceof Error && error.message ? error.message : fallback;
  };

  const act = async (work: () => Promise<GitStatus>, failure: string) => {
    setBusy(true);
    try {
      setStatus(await work());
    } catch (error) {
      void message.error(reasonFrom(error, failure));
    } finally {
      setBusy(false);
    }
  };

  /** Switches to a branch, or creates one at HEAD.
   *
   *  Separate from `act` because this answers with the branch list as well as
   *  the status, and both have to land together or the picker shows the old
   *  branch as current.
   */
  const changeBranch = async (name: string, create: boolean) => {
    setBusy(true);
    try {
      const result = await gitBranchApi(projectId, name, create);
      setStatus(result.status);
      setBranches(result.branches);
      setNewBranch(null);
      // Switching rewrote the worktree, so the history belongs to the new
      // branch now.
      setCommits(await getGitLogApi(projectId, 20));
    } catch (error) {
      void message.error(
        reasonFrom(error, create ? "Could not create the branch" : "Could not switch branch"),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Stages one hunk, or unstages it when it is a staged row's diff. */
  const moveHunk = async (relPath: string, index: number, isStaged: boolean) => {
    setBusy(true);
    try {
      setStatus(await gitHunksApi(projectId, relPath, [index], isStaged));
      setHunkNonce((value) => value + 1);
    } catch (error) {
      void message.error(
        reasonFrom(error, isStaged ? "Could not unstage" : "Could not stage"),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Fetches from, or pulls the current branch off, a remote.
   *
   *  There is deliberately no push: a project can be shared, and every
   *  collaborator's code runs in the SAME container, so a credential this
   *  server handed to git there would be readable by anyone with edit access.
   *  Pushing belongs in the terminal, where the secret is the user's own and
   *  never passes through here.
   */
  const withRemote = async (name: string, pull: boolean) => {
    setBusy(true);
    try {
      const branch = status?.branch;
      if (pull && !branch) {
        void message.error("Nothing to pull onto — this branch has no commits");
        return;
      }

      setStatus(
        pull
          ? await gitPullApi(projectId, name, branch ?? "")
          : await gitFetchApi(projectId, name),
      );
      if (pull) setCommits(await getGitLogApi(projectId, 20));
    } catch (error) {
      void message.error(
        reasonFrom(error, pull ? "Could not pull" : "Could not fetch"),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Fetch, fast-forward and push, in one call.
   *
   *  The one control that does not ask which of the three you meant. It is a
   *  separate call and not these handlers in sequence, because the decisions
   *  between the legs — is there anything to pull, is there anything to push,
   *  may this caller push at all — are the server's to make: it is the side
   *  that knows whether the project is shared and whether a credential exists,
   *  and a client that guessed would guess differently from the push route.
   *
   *  A sync that pulled but could not push is a SUCCESS with a caveat, not a
   *  failure, so it reports through `warning` rather than `error`. That
   *  distinction is the whole reason the response says what it did rather than
   *  only how things ended up.
   */
  const syncNow = async (name?: string) => {
    setBusy(true);
    try {
      const result = await gitSyncApi(projectId, name ? { name } : {});
      setStatus(result.status);
      if (result.pulled > 0) setCommits(await getGitLogApi(projectId, 20));

      if (result.pushSkipped) void message.warning(result.summary);
      else void message.success(result.summary);
    } catch (error) {
      void message.error(reasonFrom(error, "Could not sync"));
    } finally {
      setBusy(false);
    }
  };

  /** Pushes the current branch.
   *
   *  The credential comes from the connected GitHub account when there is one,
   *  and from the box otherwise — a pasted token is someone pushing to a forge
   *  this server knows nothing about, and it stays possible. */
  const push = async () => {
    const name = pushingTo;
    const branch = status?.branch;
    const typed = pushToken.trim();
    if (!name || !branch || (!typed && !canUseConnection)) return;

    setBusy(true);
    try {
      setStatus(await gitPushApi(projectId, name, branch, typed || undefined));
      void message.success(`Pushed ${branch} to ${name}.`);
      closePush();
    } catch (error) {
      void message.error(reasonFrom(error, "Could not push"));
    } finally {
      setBusy(false);
    }
  };

  /** Opens the pull request dialog, having first asked whether one is already
   *  open for this branch — GitHub's "a pull request already exists" is true,
   *  unhelpful, and not where anyone would look for the link. */
  const startPullRequest = async () => {
    const branch = status?.branch;
    if (!branch) return;

    setBusy(true);
    try {
      const [existing] = await getGithubPullsApi(projectId, branch);
      setExistingPull(existing ?? null);
      setPullTitle(existing?.title ?? branch.replace(/[-_/]+/g, " ").trim());
      setPullBody("");
      // The default branch is the usual target and is not knowable from here,
      // so the repository's own answer arrives with the existing request when
      // there is one; otherwise "main" is the overwhelmingly common case and
      // the field is editable.
      setPullBase(existing?.base ?? "main");
      setOpeningPull(true);
    } catch (error) {
      void message.error(reasonFrom(error, "Could not reach GitHub"));
    } finally {
      setBusy(false);
    }
  };

  const submitPullRequest = async () => {
    const branch = status?.branch;
    const title = pullTitle.trim();
    const base = pullBase.trim();
    if (!branch || !title || !base) return;

    setBusy(true);
    try {
      const created = await createGithubPullApi(projectId, {
        title,
        head: branch,
        base,
        description: pullBody.trim(),
      });

      setOpeningPull(false);
      void message.success(`Opened pull request #${String(created.number)}.`);
      // The next thing anyone does is look at it.
      window.open(created.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      void message.error(reasonFrom(error, "Could not open the pull request"));
    } finally {
      setBusy(false);
    }
  };

  /** Clears the token as well as the dialog: it must not survive the close. */
  const closePush = () => {
    setPushingTo(null);
    setPushToken("");
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
      {/* The row holds buttons of its own — discard, stage — so it cannot be
          one. Its two actions are buttons instead: the icon opens the file,
          the label shows the change. That is also what retires the
          stopPropagation on every button in here: with no handler on the row,
          there is no longer a parent click to stop. */}
      <div
        className="rc-tree-row"
        data-active={isOpen}
        title={change.from ? `${change.from} → ${change.path}` : change.path}
      >
        <button
          type="button"
          className="rc-icon-button"
          aria-label={`Open ${name}`}
          onClick={() => {
            openFile(change.path);
          }}
        >
          <FileIcon extension={fileExtension(change.path)} name={name} />
        </button>
        <button
          type="button"
          className="rc-row-button"
          // Announces that the row expands, and into what state — the diff
          // appears below it rather than somewhere else on the page.
          aria-expanded={isOpen}
          onClick={() => {
            // Clicking an open row closes it again.
            setExpanded(isOpen ? null : key);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: 0,
            cursor: "pointer",
            color: "inherit",
          }}
        >
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
        </button>

        {canWrite && !isStaged && (
          <Tooltip title="Discard changes">
            <button
              type="button"
              className="rc-icon-button"
              aria-label={`Discard changes to ${change.path}`}
              disabled={busy}
              onClick={() => {
                setDiscarding(change);
              }}
            >
              <VscDiscard size={13} />
            </button>
          </Tooltip>
        )}

        {canWrite && (
          <Tooltip title={isStaged ? "Unstage" : "Stage"}>
            <button
              type="button"
              className="rc-icon-button"
              // A tooltip is not a label: it never reaches a screen reader,
              // and a touch device never shows one at all.
              aria-label={`${isStaged ? "Unstage" : "Stage"} ${change.path}`}
              disabled={busy}
              onClick={() => {
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
        <DiffView
          projectId={projectId}
          path={change.path}
          staged={isStaged}
          refreshKey={hunkNonce}
          onHunk={
            canWrite
              ? (index) => void moveHunk(change.path, index, isStaged)
              : undefined
          }
        />
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
                aria-label={action.title}
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
        {canWrite ? (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                ...branches
                  .filter((branch) => !branch.current)
                  .map((branch) => ({
                    key: `switch:${branch.name}`,
                    label: branch.name,
                    onClick: () => {
                      void changeBranch(branch.name, false);
                    },
                  })),
                ...(branches.length > 1 ? [{ type: "divider" as const }] : []),
                {
                  key: "new",
                  label: "New branch…",
                  onClick: () => setNewBranch(""),
                },
              ],
            }}
          >
            <button
              type="button"
              className="rc-icon-button"
              style={{ flex: 1, justifyContent: "flex-start", fontSize: 12 }}
              aria-label="Switch branch"
              disabled={busy}
            >
              {status.branch ?? "HEAD"}
              {status.unborn ? " · no commits yet" : ""}
            </button>
          </Dropdown>
        ) : (
          <span style={{ fontSize: 12, opacity: 0.75, flex: 1 }}>
            {status.branch ?? "HEAD"}
            {status.unborn ? " · no commits yet" : ""}
          </span>
        )}

        {/* git has been computing these all along and the panel showed
            neither, so "am I ahead of the remote" was a question only the
            terminal could answer. */}
        {(status.ahead ?? 0) > 0 && (
          <span
            title={`${String(status.ahead)} commit(s) to push`}
            style={{ fontSize: 11, color: "var(--rc-text-subtle)", flex: "none" }}
          >
            ↑{status.ahead}
          </span>
        )}
        {(status.behind ?? 0) > 0 && (
          <span
            title={`${String(status.behind)} commit(s) to pull`}
            style={{ fontSize: 11, color: "var(--rc-text-subtle)", flex: "none" }}
          >
            ↓{status.behind}
          </span>
        )}

        {canWrite && remotes.length > 0 && !status.unborn && (
          <Tooltip title="Sync — fetch, fast-forward, then push">
            <button
              type="button"
              className="rc-icon-button"
              aria-label="Sync with remote"
              onClick={() => void syncNow()}
              disabled={busy}
            >
              <VscSync size={14} />
            </button>
          </Tooltip>
        )}

        {githubRepo && (
          <Tooltip title={`Open ${githubRepo.owner}/${githubRepo.repo} on GitHub`}>
            <a
              className="rc-icon-button"
              aria-label="Open on GitHub"
              href={githubRepo.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <VscGithub size={14} />
            </a>
          </Tooltip>
        )}
        {canWrite && remotes.length > 0 && (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: remotes.flatMap((remote) => [
                {
                  key: `sync:${remote.name}`,
                  label: `Sync with ${remote.name}`,
                  onClick: () => void syncNow(remote.name),
                },
                {
                  key: `fetch:${remote.name}`,
                  label: `Fetch from ${remote.name}`,
                  onClick: () => void withRemote(remote.name, false),
                },
                {
                  key: `pull:${remote.name}`,
                  label: `Pull from ${remote.name}`,
                  onClick: () => void withRemote(remote.name, true),
                },
                ...(isOwner
                  ? [
                      {
                        key: `push:${remote.name}`,
                        label: `Push to ${remote.name}…`,
                        onClick: () => setPushingTo(remote.name),
                      },
                    ]
                  : []),
              ]).concat(
                // One entry, not one per remote: a pull request belongs to the
                // repository, and which one that is comes from the remotes
                // themselves rather than from a choice made here.
                isOwner && status?.branch && githubRepo
                  ? [
                      {
                        key: "pull-request",
                        label: "Open a pull request…",
                        onClick: () => void startPullRequest(),
                      },
                    ]
                  : [],
              ),
            }}
          >
            <button
              type="button"
              className="rc-icon-button"
              aria-label="Remotes"
              disabled={busy}
            >
              <VscCloud size={14} />
            </button>
          </Dropdown>
        )}

        <Tooltip title="History">
          <button
            type="button"
            className="rc-icon-button"
            aria-label="History"
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
            aria-label="Refresh"
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

      <Modal
        open={openingPull}
        title="Open a pull request"
        okText={existingPull ? "View it on GitHub" : "Open pull request"}
        okButtonProps={{ disabled: !pullTitle.trim() || !pullBase.trim() }}
        confirmLoading={busy}
        onOk={() => {
          if (existingPull) {
            window.open(existingPull.url, "_blank", "noopener,noreferrer");
            setOpeningPull(false);
            return;
          }
          void submitPullRequest();
        }}
        onCancel={() => setOpeningPull(false)}
        destroyOnHidden
      >
        {existingPull ? (
          // GitHub would refuse a second one anyway, and its message is not
          // where anyone would look for the link.
          <div style={{ fontSize: 13 }}>
            <b>#{existingPull.number}</b> is already open for{" "}
            <b>{existingPull.head}</b> into <b>{existingPull.base}</b>.
            <div
              style={{ marginTop: 6, color: "var(--rc-text-subtle)", fontSize: 12 }}
            >
              {existingPull.title}
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--rc-text-subtle)", marginBottom: 10 }}>
              From <b>{status?.branch}</b> into the branch below. Push first if
              this branch is not on GitHub yet.
            </div>

            <Input
              autoFocus
              placeholder="Title"
              value={pullTitle}
              onChange={(event) => setPullTitle(event.target.value)}
              style={{ marginBottom: 8 }}
            />
            <Input
              placeholder="Base branch"
              value={pullBase}
              onChange={(event) => setPullBase(event.target.value)}
              style={{ marginBottom: 8 }}
            />
            <Input.TextArea
              placeholder="Description (optional)"
              value={pullBody}
              onChange={(event) => setPullBody(event.target.value)}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
          </>
        )}
      </Modal>

      <Modal
        open={pushingTo !== null}
        title={`Push ${status?.branch ?? "HEAD"} to ${pushingTo ?? ""}`}
        okText="Push"
        okButtonProps={{ disabled: !pushToken.trim() && !canUseConnection }}
        confirmLoading={busy}
        onOk={() => void push()}
        onCancel={closePush}
        destroyOnHidden
      >
        {canUseConnection ? (
          <div style={{ fontSize: 13 }}>
            Pushing as your connected GitHub account.
            <div
              style={{ marginTop: 8, fontSize: 12, color: "var(--rc-text-subtle)" }}
            >
              Sharing this project disables pushing from the editor, because
              everyone with access shares its container; push from the terminal
              instead.
            </div>
          </div>
        ) : (
          <>
            <Input.Password
              autoFocus
              placeholder="Access token"
              value={pushToken}
              onChange={(event) => setPushToken(event.target.value)}
              onPressEnter={() => void push()}
            />
            <div
              style={{ marginTop: 8, fontSize: 12, color: "var(--rc-text-subtle)" }}
            >
              Used for this push only — it is not saved here, in the repository,
              or on the server. Connect GitHub from the dashboard to stop being
              asked. Sharing this project disables pushing from the editor,
              because everyone with access shares its container; push from the
              terminal instead.
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={discarding !== null}
        title="Discard changes?"
        okText="Discard"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        onOk={() => {
          const path = discarding?.path;
          if (!path) return;
          void act(
            () => gitDiscardApi(projectId, [path]),
            "Could not discard the changes",
          ).then(() => setDiscarding(null));
        }}
        onCancel={() => setDiscarding(null)}
        destroyOnHidden
      >
        <span style={{ color: "var(--rc-text-muted)" }}>
          Your changes to <b>{discarding?.path}</b> are thrown away.{" "}
          {discarding?.unstaged === "untracked"
            ? "The file is new, so it is deleted."
            : "The file goes back to the last commit."}{" "}
          This cannot be undone — the work is in no commit and git keeps no copy.
        </span>
      </Modal>

      <Modal
        open={newBranch !== null}
        title="New branch"
        okText="Create"
        okButtonProps={{ disabled: !newBranch?.trim() }}
        confirmLoading={busy}
        onOk={() => {
          const name = newBranch?.trim();
          if (name) void changeBranch(name, true);
        }}
        onCancel={() => setNewBranch(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="feature/what-you-are-doing"
          value={newBranch ?? ""}
          onChange={(event) => setNewBranch(event.target.value)}
          onPressEnter={() => {
            const name = newBranch?.trim();
            if (name) void changeBranch(name, true);
          }}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--rc-text-subtle)" }}>
          Created at the current commit, and switched to straight away.
        </div>
      </Modal>
    </div>
  );
}
