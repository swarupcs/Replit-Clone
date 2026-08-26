# Importing from GitHub, and working a repository end to end

_The goal, in the user's words: **sign in, import a GitHub repo, do anything you
could do in local VS Code, then commit, open a PR, and the rest.**_

_Composed after reading the auth, git, container and project services as they
stand. Ordered so that each phase leaves the product working._

---

## 0. What is already here

Worth establishing before planning anything, because the gap is much narrower
than "build GitHub integration" suggests. Verified against the source, not
assumed:

| Piece | State | Where |
|---|---|---|
| Sign in with GitHub | ✅ built | `service/oauthService.ts` |
| `User.githubId`, `avatarUrl` | ✅ in the schema | `prisma/schema.prisma` |
| Status, diff, stage, unstage, commit, log | ✅ | `service/gitService.ts` |
| Branches — list, create, switch | ✅ | same |
| Hunk-level staging, discard | ✅ | same |
| Remotes — list, add, remove, fetch, pull | ✅ | same |
| Push | ✅ but the token is typed in **every time** | `pushRemote` |
| Editor, terminal, preview, collaboration | ✅ | the rest of the app |

So the missing pieces are specific:

1. **The OAuth token is used once and thrown away.** `signInWithGithub`
   exchanges the code, reads the profile, and lets the token fall out of scope.
   Nothing can act on the user's behalf afterwards.
2. **Sign-in asks for `read:user user:email`** — correct for signing in, and
   nowhere near enough to read a private repository, push, or open a PR.
3. **There is no repository list and no import.** A project is scaffolded from
   a template; nothing clones.
4. **Push works but is a chore.** The token is supplied per call and never
   stored, so it is pasted in on every push.
5. **There is no pull request anything** — not creating one, not seeing one.

---

## 1. The decision the rest of this hangs on

A GitHub token with `repo` scope can read and rewrite every repository the
person can. Where it is kept, and where it is *spent*, is the whole security
story — and the answer is already half-written in `docs/SECURITY.md`, because
push had to solve a version of it:

> a credential is only ever as private as the container it is spent in. Every
> collaborator on a project works in the **same container**.

That rule does not change. What changes is that the token no longer has to be
typed each time. Concretely:

- **At rest**: encrypted with AES-256-GCM under a server key, in a row of its
  own. Never in the project, never in `.git/config`, never in a remote URL.
- **Server-side use** (listing repos, opening a PR): decrypted in memory for
  one API call. The token never leaves the server process.
- **Container-side use** (clone, push): the existing rule applies unchanged —
  only when the project has no collaborators and no outstanding share link, and
  passed in the exec's **environment** rather than its arguments, because
  process arguments are world-readable through `/proc`.
- **Two consents, not one.** Signing in keeps `read:user user:email`. Reaching
  repositories is a separate, explicit "Connect GitHub" step that asks for
  `repo`. Nobody is made to grant write access to a private repository in order
  to log in.
- **Disconnecting means it is gone**: the row is deleted, not flagged.

## 2. Where the clone runs

The clone is the one genuinely new kind of operation, and it has an obvious
wrong answer: run `git clone` on the host. The server does not shell out on the
host for user-driven work — that is what the container is for — and a URL from
a browser driving a network fetch on the host is exactly the sort of thing that
invariant exists to prevent.

So the clone runs **inside a container**, through the same `execCapture` path
every other git call uses. Two consequences worth stating:

- A brand-new project has no collaborators and no share link by construction,
  so an import is always sole-occupant. The rule that governs push is satisfied
  at import time without a special case.
- The importing container needs an image before the repo's language is known.
  It uses the Node sandbox image to clone, then the language is detected from
  what landed and the project's template is set accordingly. The image only
  decides what *runs*; it does not have to match to hold the files.

URLs are constructed by the server from `owner/repo` chosen out of the API's
own list. A user-supplied URL string is never cloned, which removes the
`ext::`-style transport question entirely rather than answering it.

---

## 3. Phases

Each is a commit, each verified before the next starts.

### Phase 1 — Keep the connection
- `GithubConnection` model: one per user, encrypted token, granted scopes,
  login, timestamps. Migration.
- `lib/secretBox.ts`: AES-256-GCM seal/open under `GITHUB_TOKEN_KEY`. Absent
  key ⇒ the feature reports itself unconfigured, the way GitHub sign-in already
  does, rather than failing obscurely.
- `GET /github/status`, `POST /github/connect` (authorise URL for the `repo`
  scope), the callback, `DELETE /github/connection`.
- The web app: a GitHub section in settings showing connected/not, the login,
  and a disconnect.

### Phase 2 — See the repositories
- `GET /github/repos` — the caller's repositories, newest push first,
  searchable, paginated. Server-side only; the token never reaches the browser.
- Shared types for the repo shape.

### Phase 3 — Import one
- `POST /projects/import { owner, repo, ref? }` — quota-checked, creates the
  project row, clones into it in a container, detects the template from what
  arrived, sets `origin` to the credential-free HTTPS URL.
- Refuses a repository above a size the disk quota cannot take, before cloning
  rather than after.
- The dashboard: "Import from GitHub" beside "New playground", with a repo
  picker.

### Phase 4 — Push without retyping
- `pushRemote` takes the token from the stored connection when the caller is
  the owner and the project is unshared. The manual entry stays as the fallback
  for anyone who has not connected.
- The push dialog stops asking when a connection exists.

### Phase 5 — Pull requests
- `POST /github/pull-requests` — open a PR from the project's branch.
- `GET /github/pull-requests` — the open ones for this repo, so the panel can
  say "there is already a PR for this branch" instead of failing on the second
  attempt.
- Source-control panel: an "Open a pull request" action that appears once the
  branch is pushed and the project has a GitHub origin.

### Phase 6 — The rest of the loop
- Show the origin and the current branch's upstream state (ahead/behind).
- "Open on GitHub" for the repo, the branch and the PR.
- Sync: fetch + fast-forward pull, already built, surfaced properly.

---

## 4. Assumptions

- **GitHub only.** GitLab and Bitbucket are the same shape but a different API;
  the design does not preclude them and this plan does not build them.
- **HTTPS, not SSH.** An SSH deploy key per project is a bigger key-management
  story and buys nothing here, since the token already exists.
- **A repository is one project.** Monorepo sub-directory imports are not in
  scope.
- **`repo` scope, not fine-grained tokens.** Fine-grained PATs cannot be
  obtained through OAuth; a GitHub App could, and is the better long-term
  answer, but it is a heavier setup for a self-hosted install.

## 5. Progress

- [x] Phase 1 — keep the connection
- [x] Phase 2 — see the repositories
- [x] Phase 3 — import one
- [x] Phase 4 — push without retyping
- [x] Phase 5 — pull requests
- [x] Phase 6 — the rest of the loop

### Notes from building it

- **The clone image problem had a simpler answer than expected.** A template
  decides what *runs*; it does not have to match to hold files. So the Node
  image clones, the language is read off what arrived, and the container is
  removed so the next open starts the right one.
- **Which repository a project belongs to is derived, never asked for.** It
  comes from the project's own remotes, parsed server-side. A browser telling
  the server which repository to open a pull request against is a thing to get
  wrong or to lie about.
- **`ext::` never came up.** The import URL is built from a name the GitHub API
  returned, so there is no user-supplied URL to validate — which removes the
  question instead of answering it. The existing allow-list still guards
  remotes a user adds by hand.
- **What is still missing:** the start command for an imported repository comes
  from the detected template and will often be wrong for a real project. The
  template registry has a fixed set, and a repository's actual `npm start` is
  not in it. Worth reading `package.json` scripts for; not done here.
