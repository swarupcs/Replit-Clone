/** Turning one webhook delivery into a decision. plan.md §13.3.
 *
 *  Everything here is pure: a delivery in, a decision out, no database and no
 *  network. That is deliberate — the interesting part of a webhook receiver is
 *  *which* deliveries it acts on, and that is exactly the part which is
 *  untestable once it is entangled with the acting.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestRef {
  number: number;
  /** The branch the pull request is *from*, which is what gets a workspace. */
  headRef: string;
  headSha: string;
  title: string;
}

export type WebhookDecision =
  /** GitHub's handshake when the App is first pointed at this URL. */
  | { kind: "ping" }
  /** Create the workspace if it is new, refresh it if the head moved. */
  | { kind: "upsert"; repo: RepoRef; pull: PullRequestRef }
  /** Merged or closed: give the memory and the disk back. */
  | { kind: "teardown"; repo: RepoRef; number: number; merged: boolean }
  /** A push to a branch — §12.2's missing trigger, with a reason attached. */
  | { kind: "rebuild"; repo: RepoRef; branch: string; sha: string }
  /** Everything else, with the why kept for the log and for the tests. */
  | { kind: "ignore"; why: string };

/** GitHub's own naming rules. Anything outside this is not a repository this
 *  server could clone, and these values reach a path and a command line. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
/** A ref git will accept and that cannot be read as an option. `..` is refused
 *  outright: it is legal in neither a branch name nor a path this builds. */
const REF_PATTERN = /^[A-Za-z0-9._\-/]+$/;

function nameable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    NAME_PATTERN.test(value) &&
    !value.startsWith("-")
  );
}

function refable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    REF_PATTERN.test(value) &&
    !value.startsWith("-") &&
    !value.includes("..")
  );
}

function shaLike(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

interface RawRepository {
  name?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown };
  fork?: unknown;
}

function repoOf(raw: RawRepository | undefined): RepoRef | undefined {
  const owner = raw?.owner?.login;
  const repo = raw?.name;
  if (!nameable(owner) || !nameable(repo)) return undefined;
  return { owner, repo };
}

interface RawPullRequestPayload {
  action?: unknown;
  number?: unknown;
  repository?: RawRepository;
  pull_request?: {
    number?: unknown;
    title?: unknown;
    merged?: unknown;
    head?: { ref?: unknown; sha?: unknown; repo?: RawRepository };
    base?: { repo?: RawRepository };
  };
}

interface RawPushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: RawRepository;
}

/** The actions worth a workspace. A pull request emits a dozen more — labeled,
 *  assigned, edited, review_requested — and none of them changes the code. */
const UPSERT_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export function decide(event: string, payload: unknown): WebhookDecision {
  if (event === "ping") return { kind: "ping" };
  if (typeof payload !== "object" || payload === null) {
    return { kind: "ignore", why: "payload is not an object" };
  }

  if (event === "pull_request") return decidePullRequest(payload);
  if (event === "push") return decidePush(payload);

  return { kind: "ignore", why: `unhandled event ${event}` };
}

function decidePullRequest(payload: RawPullRequestPayload): WebhookDecision {
  const action = payload.action;
  if (typeof action !== "string") return { kind: "ignore", why: "no action" };

  const base = repoOf(payload.repository);
  if (!base) return { kind: "ignore", why: "unusable repository" };

  const pr = payload.pull_request;
  const number = typeof pr?.number === "number" ? pr.number : payload.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    return { kind: "ignore", why: "no pull request number" };
  }

  if (action === "closed") {
    return { kind: "teardown", repo: base, number, merged: pr?.merged === true };
  }

  if (!UPSERT_ACTIONS.has(action)) {
    return { kind: "ignore", why: `pull_request action ${action}` };
  }

  // **A pull request from a fork is a stranger's code, and this refuses it.**
  //
  // Building one means cloning a branch nobody here controls and running its
  // install scripts and dev server on this host — which is the same thing §6
  // decision 13 refused for anonymous sandboxes, arriving by a different road
  // and wearing a collaborator's clothes. A fork PR is the ordinary way an
  // outside contributor sends a change, so this is not an edge case; it is the
  // majority case for a public repository, and refusing it is the honest
  // limit of the row rather than an oversight in it.
  const headRepo = repoOf(pr?.head?.repo);
  if (!headRepo || headRepo.owner !== base.owner || headRepo.repo !== base.repo) {
    return { kind: "ignore", why: "pull request from a fork" };
  }

  const headRef = pr?.head?.ref;
  const headSha = pr?.head?.sha;
  if (!refable(headRef)) return { kind: "ignore", why: "unusable head ref" };
  if (!shaLike(headSha)) return { kind: "ignore", why: "unusable head sha" };

  const rawTitle = pr?.title;
  return {
    kind: "upsert",
    repo: base,
    pull: {
      number,
      headRef,
      headSha,
      // Titles are somebody else's free text and end up in a comment and a
      // project name. Trimmed to something bounded here rather than wherever
      // it is finally rendered.
      title: typeof rawTitle === "string" ? rawTitle.slice(0, 200) : `#${String(number)}`,
    },
  };
}

function decidePush(payload: RawPushPayload): WebhookDecision {
  const repo = repoOf(payload.repository);
  if (!repo) return { kind: "ignore", why: "unusable repository" };

  // A tag push is not a branch and has no workspace; a branch deletion has
  // nothing left to build.
  const ref = payload.ref;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    return { kind: "ignore", why: "not a branch push" };
  }
  if (payload.deleted === true) return { kind: "ignore", why: "branch deleted" };

  const branch = ref.slice("refs/heads/".length);
  if (!refable(branch)) return { kind: "ignore", why: "unusable branch" };

  const sha = payload.after;
  // The all-zero sha is how GitHub spells "this ref is gone" when `deleted` is
  // absent, which it is on some older deliveries.
  if (!shaLike(sha) || /^0{40}$/.test(sha)) {
    return { kind: "ignore", why: "no head commit" };
  }

  return { kind: "rebuild", repo, branch, sha };
}
