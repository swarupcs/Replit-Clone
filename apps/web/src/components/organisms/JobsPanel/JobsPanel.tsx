import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Input, Spin, Switch, Tooltip, message } from "antd";
import { VscAdd, VscPlay, VscTrash } from "react-icons/vsc";
import {
  MAX_JOBS_PER_PROJECT,
  MIN_INTERVAL_MINUTES,
  type ScheduledJob,
  type ScheduledRun,
} from "@replit-clone/shared";
import {
  createJobApi,
  deleteJobApi,
  listJobsApi,
  runJobApi,
  updateJobApi,
} from "../../../apis/schedules.ts";

/** Commands this project runs on a schedule.
 *
 *  The panel is mostly about one thing: making the difference between "it did
 *  not run" and "it ran and failed" visible without opening anything. A
 *  schedule is the one feature nobody watches — its failure mode is silence,
 *  and a row that says only "enabled" is a row that looks fine for weeks while
 *  the backup it promised has been exiting 1 every night.
 *
 *  So every job shows its last outcome and its next firing, and both are read
 *  from the server rather than computed here. The next firing in particular:
 *  the server has the cron parser, and a second implementation in the browser
 *  would be a second thing to be wrong.
 */
interface JobsPanelProps {
  projectId: string;
  isOwner: boolean;
}

/** How a run reads at a glance. */
const OUTCOME: Record<ScheduledRun["status"], { label: string; tone: string }> = {
  RUNNING: { label: "running", tone: "busy" },
  SUCCEEDED: { label: "ok", tone: "ok" },
  FAILED: { label: "failed", tone: "bad" },
  // Four ways of not finishing, kept apart because the fix differs: a skipped
  // job is scheduled too often, a timed-out one is slower than its budget, an
  // errored one never reached the container at all, and an interrupted one
  // started and was never seen again -- the only case where what the command
  // managed to do is genuinely unknown, which is why it does not say "failed".
  SKIPPED: { label: "skipped", tone: "warn" },
  TIMED_OUT: { label: "timed out", tone: "warn" },
  ERRORED: { label: "could not start", tone: "bad" },
  ABANDONED: { label: "interrupted", tone: "warn" },
};

function when(iso: string | null): string {
  if (!iso) return "—";

  const at = new Date(iso);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  const ahead = minutes >= 0;
  const size = Math.abs(minutes);

  if (size < 1) return ahead ? "in under a minute" : "just now";
  if (size < 60) return ahead ? `in ${String(size)}m` : `${String(size)}m ago`;
  if (size < 60 * 24) {
    const hours = Math.round(size / 60);
    return ahead ? `in ${String(hours)}h` : `${String(hours)}h ago`;
  }

  // Past a day the clock time is more use than the arithmetic, and it is UTC
  // because that is what the schedule itself is in.
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const JobsPanel = ({ projectId, isOwner }: JobsPanelProps) => {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", schedule: "", command: "" });

  const refresh = useCallback(async () => {
    try {
      setJobs(await listJobsApi(projectId));
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Could not load the jobs";
      message.error(reason);
      // An empty list rather than a spinner forever: the panel has to settle
      // into a state a person can act from even when the read failed.
      setJobs([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      message.success(done);
      await refresh();
    } catch (error) {
      // The server's own words. Every refusal here says what to do next --
      // the expression never fires, it fires too often, the project is full --
      // and a generic message would throw all of that away.
      const reason = error instanceof Error ? error.message : "That did not work";
      message.error(reason);
    } finally {
      setBusy(false);
    }
  };

  if (jobs === null) {
    return (
      <div className="rc-jobs-loading">
        <Spin size="small" />
      </div>
    );
  }

  const full = jobs.length >= MAX_JOBS_PER_PROJECT;

  return (
    <div className="rc-jobs">
      <div className="rc-jobs-head">
        <span className="rc-jobs-title">Scheduled jobs</span>
        {isOwner && !adding && (
          <Tooltip
            title={
              full
                ? `A project may have ${String(MAX_JOBS_PER_PROJECT)} jobs.`
                : "Add a job"
            }
          >
            {/* Wrapped, because a disabled antd button swallows the events a
                tooltip needs and the explanation is the point when it is
                disabled. */}
            <span>
              <Button
                size="small"
                type="text"
                disabled={full}
                aria-label="Add a job"
                icon={<VscAdd size={13} />}
                onClick={() => setAdding(true)}
              />
            </span>
          </Tooltip>
        )}
      </div>

      {jobs.length === 0 && !adding && (
        <div className="rc-jobs-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="rc-deploy-blurb">
                Run a command on a schedule — a backup, a fetch, a digest. It
                runs in this project&apos;s container, in UTC, at most once
                every {MIN_INTERVAL_MINUTES} minutes.
              </span>
            }
          />
        </div>
      )}

      {adding && (
        <div className="rc-jobs-form">
          <Input
            size="small"
            placeholder="Nightly backup"
            aria-label="Job name"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <Input
            size="small"
            placeholder="0 3 * * *"
            aria-label="Schedule"
            value={draft.schedule}
            onChange={(event) =>
              setDraft({ ...draft, schedule: event.target.value })
            }
          />
          <Input
            size="small"
            placeholder="npm run backup"
            aria-label="Command"
            value={draft.command}
            onChange={(event) =>
              setDraft({ ...draft, command: event.target.value })
            }
          />
          {/* The dialect, stated where somebody is typing it rather than in
              documentation they would have to go and find. */}
          <p className="rc-jobs-hint">
            Five cron fields in UTC — minute, hour, day of month, month, day of
            week. <code>@daily</code> and <code>@hourly</code> work too.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              size="small"
              type="primary"
              loading={busy}
              disabled={
                !draft.name.trim() ||
                !draft.schedule.trim() ||
                !draft.command.trim()
              }
              onClick={() =>
                void run(async () => {
                  await createJobApi(projectId, {
                    name: draft.name.trim(),
                    schedule: draft.schedule.trim(),
                    command: draft.command.trim(),
                  });
                  setDraft({ name: "", schedule: "", command: "" });
                  setAdding(false);
                }, "Job scheduled")
              }
            >
              Save
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                // Kept rather than cleared: cancelling a form and losing what
                // was typed is its own small betrayal.
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="rc-jobs-list">
        {jobs.map((job) => (
          <div className="rc-job" key={job.id}>
            <div className="rc-job-head">
              <span className="rc-job-name" title={job.name}>
                {job.name}
              </span>
              {job.lastRun && (
                <span
                  className="rc-job-outcome"
                  data-tone={OUTCOME[job.lastRun.status].tone}
                  title={
                    job.lastRun.exitCode === null
                      ? undefined
                      : `exit ${String(job.lastRun.exitCode)}`
                  }
                >
                  {OUTCOME[job.lastRun.status].label}
                </span>
              )}
            </div>

            <code className="rc-job-command" title={job.command}>
              {job.command}
            </code>

            <div className="rc-job-meta">
              <span title="UTC">{job.schedule}</span>
              <span>
                {job.enabled ? `next ${when(job.nextRunAt)}` : "paused"}
              </span>
              {job.lastRun && <span>ran {when(job.lastRun.startedAt)}</span>}
            </div>

            {/* Only when there is something to read. An empty <pre> is a box
                that implies output was lost rather than never produced. */}
            {job.lastRun?.output && (
              <pre className="rc-job-output" aria-label={`${job.name} output`}>
                {job.lastRun.output}
              </pre>
            )}

            {isOwner && (
              <div className="rc-job-actions">
                <Tooltip title={job.enabled ? "Pause" : "Resume"}>
                  <Switch
                    size="small"
                    checked={job.enabled}
                    disabled={busy}
                    aria-label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`}
                    onChange={(next) =>
                      void run(
                        () => updateJobApi(projectId, job.id, { enabled: next }),
                        next ? "Resumed" : "Paused",
                      )
                    }
                  />
                </Tooltip>
                <Tooltip title="Run it now, outside its schedule">
                  <Button
                    size="small"
                    type="text"
                    loading={busy}
                    aria-label={`Run ${job.name} now`}
                    icon={<VscPlay size={13} />}
                    onClick={() =>
                      void run(
                        () => runJobApi(projectId, job.id),
                        "Ran the job",
                      )
                    }
                  />
                </Tooltip>
                <Tooltip title="Delete this job and its history">
                  <Button
                    size="small"
                    type="text"
                    danger
                    disabled={busy}
                    aria-label={`Delete ${job.name}`}
                    icon={<VscTrash size={13} />}
                    onClick={() =>
                      void run(
                        () => deleteJobApi(projectId, job.id),
                        "Job deleted",
                      )
                    }
                  />
                </Tooltip>
              </div>
            )}
          </div>
        ))}
      </div>

      {!isOwner && jobs.length > 0 && (
        <p className="rc-deploy-blurb">
          Only the project&apos;s owner can change what runs.
        </p>
      )}
    </div>
  );
};
