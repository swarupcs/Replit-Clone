# Backup and restore

Until this existed, everything a user had lived in exactly one place: the
working tree under `PROJECTS_DIR` and the rows in one Postgres. Nothing copied
either anywhere else, ever. `plan.md` §3.3 carried that as the only open row
that **loses data** rather than failing to add a feature, and §14 puts it ahead
of everything that does add one.

Two things that already existed and do **not** solve it, because both get
mistaken for it:

- **Checkpoints** are per-file snapshots on the same disk as the tree they
  snapshot. They answer "what did this file look like an hour ago".
- **Export** (`GET /:projectId/export`) is a manual, per-project, user-initiated
  zip. A backup is the one that runs when nobody remembers to.
- **The trash** (§9.1) answers "I meant the other project". This answers "the
  host died", and only the second needs a destination.

## Turning it on

Backups are **off** until you name a destination. Set one:

```bash
BACKUP_DIR=/mnt/backups
```

The server refuses to start if that path is inside `PROJECTS_DIR`, or holds it.
A backup on the same disk as the thing it backs up is not a backup — it is a
second copy that dies in the same accident — and this is a mistake that
otherwise works perfectly every night until the day it matters.

Two other settings, both optional:

```bash
BACKUP_INTERVAL_HOURS=24   # how often the sweep runs
BACKUP_KEEP=7              # how many copies of one project are kept
```

The first sweep runs one interval after boot, not at boot: a restart is the
moment the host is busiest, and a crash-looping server would otherwise archive
every tree on every restart.

**Where that directory actually is, is your decision and deliberately not this
server's.** It writes files to a path. A second physical disk, an NFS or SMB
mount, an `rclone mount` in front of object storage, or a plain directory that
something else rsyncs off the host afterwards are all the same to it, and it has
no information with which to choose between them. What it will not do is
pretend a directory on the same disk is a backup.

**Whatever it points at is as sensitive as the database.** The archives carry
project source, and `project.json` carries the project row — including
environment variables, which are sealed but present.

## Checking it is working

The operator console's **Machine** panel shows the last sweep: how many projects
were copied, when, and where they went. Two states are worth reading carefully:

- **"Backups are off"** — nothing on this host is copied anywhere else.
- **"Backups are on, and have not run yet in this process"** — configured, and
  silent. After an uptime longer than `BACKUP_INTERVAL_HOURS` that means it is
  not running, which is the exact shape of a broken backup system and the one a
  green tick would hide.

The counters `backups_completed` and `backups_failed` are on the same panel and
on `/metrics`. A sweep in which *anything* failed is reported as failed, not as
mostly-fine: a backup system that reports green because most of it worked is one
nobody checks.

## What is in a backup

Per project, under `<BACKUP_DIR>/<projectId>/<timestamp>/`:

| File | What it is |
|---|---|
| `tree.tar.gz` | the working tree |
| `project.json` | the project row, its collaborators, scheduled jobs and database connections |
| `manifest.json` | format version, sizes, the archive's sha256, and the project's `updatedAt` at the moment it was copied |

`manifest.json` is written **last**, and it is the completion marker: a
directory without one is ignored by everything, so a sweep killed halfway
through leaves nothing that could be restored from.

**`.git` is included.** Duplicates and exports drop it, correctly — a copy does
not want somebody else's history. A backup is the opposite case: the history is
the work.

**`node_modules`, `dist`, `build`, `.next`, `__pycache__` and `.venv` are
excluded.** All reproducible from a manifest that is backed up, and between them
usually most of a tree's bytes.

**Two things are deliberately not backed up**, and both say so in the manifest
rather than being silently absent:

- **Folders you opened rather than created** (`plan.md` §10.2). That tree lives
  somewhere you already manage, and copying arbitrary host paths into a backup
  destination is a surprise nobody asked for. The manifest records the path so a
  restore can tell you what it did not restore.
- **Deployments and releases.** They describe build output and containers that
  do not exist after a host loss anyway. A restore republishes rather than
  resurrects.

A project only gets a new backup when it has changed since the last one —
compared on the project's own `updatedAt`, not on the clock, so a server whose
time steps forward cannot silently decide nothing has changed.

## Restoring

The command is a script rather than an endpoint, because the case it is for is a
**new host**: there is no session to authorise a request with and no dashboard to
press a button on.

```bash
# in a deployment
node dist/scripts/restore.js --list <projectId>

# in development
pnpm --filter @replit-clone/server exec tsx src/scripts/restore.ts --list <projectId>
```

Work up to it, and nothing before the last step changes anything:

```bash
restore --list   <projectId>            # what backups exist
restore --verify <projectId>            # does the newest archive match its digest
restore --plan   <projectId>            # exactly what a restore would do
restore          <projectId>            # do it
restore          <projectId> --force    # ...even though a tree is already there
restore          <projectId> --at <ms>  # a specific backup, not the newest
```

`BACKUP_DIR` and `DATABASE_URL` must be set for the process running it — it is
the same server code reading the same configuration.

### What it will not do

- **It will not restore over an existing tree** without `--force`, and with
  `--force` it **moves the tree aside rather than deleting it**
  (`<project>.displaced-<timestamp>`). A restore is reached for by somebody
  guessing, and if it was the wrong backup, what they replaced is still there.
- **It will not restore an archive that fails its digest.** Pass `--skip-verify`
  to restore a damaged one knowingly.
- **It will not restore a project row whose owner is not on this server.** The
  files are restored and it says so; create the account and run it again.

### The two things that will bite you

**`SECRET_ENCRYPTION_KEY`.** Environment variables are sealed with it. Restoring
onto a deployment with a different key restores rows that decrypt to nothing —
and nothing errors, so the failure surfaces as an app that cannot reach its
database. Keep that key with the backups' *documentation*, not in them.

**Ownership.** The restore hands the tree to the sandbox user (uid 1001) itself,
so the project is writable. If it could not — a non-root server — it says so in
its warnings, and the project will open read-only.

## Restoring a whole host

1. Bring up a server with the same `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, and
   `JWT_*` secrets, and let it apply migrations.
2. Recreate the accounts. `project.json` carries the project's `ownerId`, not the
   user rows — a restore will tell you which owner it could not find.
3. For each project: `restore --plan <id>`, read it, then `restore <id>`.
4. Republish anything that was deployed. Deployments are rebuilt, not restored.

## What this does not do yet

Recorded honestly rather than left to be discovered:

- **It has never been run against a real host loss.** The round trip is tested —
  a real archive written and unpacked back — but nobody has rebuilt a machine
  from this. Until somebody has, treat the runbook above as untested.
- **There is no global "restore everything" command.** Per project, on purpose:
  the first restore anybody performs should be one they can read the plan for.
- **User accounts are not backed up.** Only the projects and the rows that hang
  off them. A host loss therefore needs the accounts recreated first.
- **Nothing off-machine is automated.** If `BACKUP_DIR` is a local disk, moving
  those files somewhere else is still yours to arrange.
