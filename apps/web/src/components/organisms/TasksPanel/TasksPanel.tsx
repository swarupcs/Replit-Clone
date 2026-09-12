import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Tag, Typography, message } from "antd";
import { VscPlay } from "react-icons/vsc";
import type { TaskList, TaskRun } from "@replit-clone/shared";
import { getTasksApi, runTaskApi } from "../../../apis/projects.ts";
import { useProblemsStore } from "../../../store/problemsStore.ts";

/** Tasks from `.vscode/tasks.json`. plan.md §10.10.
 *
 *  The list is the small half. The point of the row is that a task's output
 *  goes through a problem matcher and lands in the problems panel — so a build
 *  error becomes something you click, rather than something you read in a
 *  terminal and then go looking for.
 */
export function TasksPanel({
  projectId,
  canRun,
}: {
  projectId: string;
  canRun: boolean;
}) {
  const [list, setList] = useState<TaskList>({ tasks: [], problems: [] });
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const setTaskProblems = useProblemsStore((state) => state.setTaskProblems);

  const load = useCallback(async () => {
    try {
      setList(await getTasksApi(projectId));
    } catch {
      // A project with no tasks.json is the ordinary case; the empty state
      // below says it better than an error would.
      setList({ tasks: [], problems: [] });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string): Promise<void> => {
    setRunning(label);
    try {
      const result = await runTaskApi(projectId, label);
      setRuns(result);

      // Replaced wholesale, not appended: the problems from a task are true
      // until that task runs again, and keeping the previous run's would mean
      // a fixed error staying on screen until somebody reloads.
      setTaskProblems(
        result.flatMap((entry) =>
          entry.problems.map((problem) => ({
            relPath: problem.relPath,
            line: problem.line,
            column: problem.column,
            message: problem.message,
            severity: problem.severity,
            source: problem.source,
          })),
        ),
      );
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "The task failed");
    } finally {
      setRunning(null);
    }
  };

  const last = runs[runs.length - 1];

  return (
    <div style={{ display: "grid", gap: 10, padding: 8, overflowY: "auto" }}>
      {list.problems.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="tasks.json has problems"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {list.problems.map((problem) => (
                <li key={problem} style={{ fontSize: 12 }}>
                  {problem}
                </li>
              ))}
            </ul>
          }
        />
      )}

      {list.tasks.length === 0 ? (
        <Empty
          image={null}
          description={
            <span style={{ fontSize: 12.5, color: "var(--rc-text-subtle)" }}>
              No tasks. Add <code>.vscode/tasks.json</code> and they appear here.
            </span>
          }
        />
      ) : (
        list.tasks.map((task) => (
          <div
            key={task.label}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                {task.label}{" "}
                {task.group !== "none" && <Tag color="default">{task.group}</Tag>}
                {/* Named, because this platform will refuse to run it and the
                    reason belongs where somebody looks for the button. */}
                {task.background && <Tag color="default">background</Tag>}
              </div>
              <code
                style={{
                  color: "var(--rc-text-subtle)",
                  fontSize: 11.5,
                  overflowWrap: "anywhere",
                }}
              >
                {task.command}
              </code>
            </div>
            {canRun && (
              <Button
                size="small"
                icon={<VscPlay />}
                loading={running === task.label}
                aria-label={`Run ${task.label}`}
                onClick={() => {
                  void run(task.label);
                }}
              >
                Run
              </Button>
            )}
          </div>
        ))
      )}

      {last && (
        <div style={{ display: "grid", gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 12.5 }}>
            {last.refusal
              ? last.label
              : `${last.label} — exit ${String(last.exitCode)}`}
          </Typography.Text>

          {last.refusal ? (
            <Alert type="info" showIcon message={last.refusal} />
          ) : (
            <pre
              style={{
                margin: 0,
                maxHeight: 220,
                overflow: "auto",
                fontSize: 11.5,
                background: "var(--rc-surface-sunken, rgba(127,127,127,0.12))",
                padding: 8,
                borderRadius: 6,
              }}
            >
              {last.output || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default TasksPanel;
