import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Input, Spin, Tooltip, message } from "antd";
import { VscPlay, VscSave } from "react-icons/vsc";
import type { TestCommand, TestRun } from "@replit-clone/shared";
import {
  getTestCommandApi,
  runTestsApi,
  setTestCommandApi,
} from "../../../apis/tests.ts";

/** Running this project's tests, and reading what happened.
 *
 *  The panel is mostly about the output. "Failed" on its own sends somebody
 *  back to a terminal, which is the thing this exists to replace — so the
 *  output is always shown, always scrollable, and never summarised.
 *
 *  Four outcomes rather than pass/fail, for the reason the scheduler keeps six:
 *  "the tests failed", "they took too long", and "we could not run them at
 *  all" are three different problems. A panel that says failed for the last
 *  one sends somebody to read their own code for a Docker outage.
 */
interface TestsPanelProps {
  projectId: string;
  /** Running executes code in the container — the same grant `Run` needs, and
   *  not one read-only access implies. */
  canRun: boolean;
  /** Changing what runs is the owner's. */
  isOwner: boolean;
}

const OUTCOME: Record<TestRun["status"], { label: string; tone: string }> = {
  PASSED: { label: "passed", tone: "ok" },
  FAILED: { label: "failed", tone: "bad" },
  TIMED_OUT: { label: "timed out", tone: "warn" },
  // Never the tests' fault, and worth saying so in the word itself.
  ERRORED: { label: "could not run", tone: "bad" },
};

export const TestsPanel = ({ projectId, canRun, isOwner }: TestsPanelProps) => {
  const [command, setCommand] = useState<TestCommand | null>(null);
  const [draft, setDraft] = useState("");
  const [run, setRun] = useState<TestRun | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getTestCommandApi(projectId);
      setCommand(next);
      setDraft(next.fromTemplate ? "" : (next.command ?? ""));
    } catch {
      // A panel that cannot read the command is still a panel. The failure
      // that matters here is the run's, and that one is reported.
      setCommand({ command: null, fromTemplate: false });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    // Cleared rather than left showing: a previous result beside a running
    // spinner reads as the current one.
    setRun(null);

    try {
      setRun(await runTestsApi(projectId));
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "Could not run the tests",
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const next = await setTestCommandApi(projectId, draft);
      setCommand(next);
      message.success(
        draft.trim().length > 0
          ? "Test command saved"
          : "Back to the template's default",
      );
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "Could not save that",
      );
    } finally {
      setBusy(false);
    }
  };

  if (command === null) {
    return (
      <div className="rc-tests-loading">
        <Spin size="small" />
      </div>
    );
  }

  return (
    <div className="rc-tests">
      <div className="rc-tests-head">
        <span className="rc-tests-title">Tests</span>
        {canRun && command.command && (
          <Tooltip title={`Run ${command.command}`}>
            <Button
              size="small"
              type="text"
              loading={busy}
              aria-label="Run the tests"
              icon={<VscPlay size={13} />}
              onClick={() => void start()}
            />
          </Tooltip>
        )}
      </div>

      {command.command ? (
        <div className="rc-tests-command">
          <code title={command.command}>{command.command}</code>
          {command.fromTemplate && (
            <span className="rc-tests-source">from this template</span>
          )}
        </div>
      ) : (
        <div className="rc-tests-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="rc-deploy-blurb">
                {isOwner
                  ? "No test command yet. Set one below and it runs in this project's container."
                  : "This project has no test command. Its owner can set one."}
              </span>
            }
          />
        </div>
      )}

      {isOwner && (
        <div className="rc-tests-form">
          <Input
            size="small"
            placeholder={command.fromTemplate ? command.command ?? "npm test" : "npm test"}
            aria-label="Test command"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => void save()}
          />
          <Tooltip title="Leave it empty to go back to the template's default">
            <Button
              size="small"
              disabled={busy}
              aria-label="Save the test command"
              icon={<VscSave size={13} />}
              onClick={() => void save()}
            />
          </Tooltip>
        </div>
      )}

      {busy && !run && (
        <div className="rc-tests-loading">
          <Spin size="small" />
        </div>
      )}

      {run && (
        <div className="rc-tests-result">
          <div className="rc-tests-outcome">
            <span
              className="rc-job-outcome"
              data-tone={OUTCOME[run.status].tone}
              title={
                run.exitCode === null ? undefined : `exit ${String(run.exitCode)}`
              }
            >
              {OUTCOME[run.status].label}
            </span>
            <span className="rc-tests-took">{took(run)}</span>
          </div>

          {/* Always shown when there is any. The output IS the answer, and a
              status with nothing under it is what sends people back to a
              terminal. */}
          {run.output.length > 0 && (
            <pre className="rc-tests-output" aria-label="Test output">
              {run.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** How long it took, in the coarsest unit that is still true. */
function took(run: TestRun): string {
  const ms =
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();

  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${String(Math.round(ms / 60_000))}m`;
}
