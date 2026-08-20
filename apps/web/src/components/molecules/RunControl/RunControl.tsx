import { Button, Space, Tooltip } from "antd";
import {
  CaretRightFilled,
  LoadingOutlined,
  BorderOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { RunStatus } from "@replit-clone/shared";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../../../store/editorSocketStore.ts";
import { useRunStore } from "../../../store/runStore.ts";

const STATUS_COPY: Record<RunStatus, { label: string; color: string }> = {
  idle: { label: "Stopped", color: "var(--rc-text-subtle)" },
  starting: { label: "Starting", color: "var(--rc-yellow)" },
  running: { label: "Running", color: "var(--rc-green)" },
  exited: { label: "Exited", color: "var(--rc-red)" },
};

/** Run / Stop for the project's dev server.
 *
 *  The template's start command was already defined server-side and injected
 *  into terminals as $START_COMMAND, but nothing surfaced it -- you had to know
 *  to type `npm install && npm run dev` yourself, and forgetting the install
 *  step produced a bare MODULE_NOT_FOUND.
 */
/** Formats a byte count for a status readout, not for precision. */
function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024).toString()} MB`;
}

/** "in 4 min", "in 45 s" — a countdown only matters at human resolution. */
function formatCountdown(seconds: number): string {
  if (seconds >= 120) return `${Math.round(seconds / 60).toString()} min`;
  return `${seconds.toString()} s`;
}

export const RunControl = () => {
  const { editorSocket } = useEditorSocketStore();
  const canEdit = useEditorSocketStore(selectCanEdit);
  const { status, exitCode, command } = useRunStore((store) => store.state);
  const stats = useRunStore((store) => store.stats);

  const isBusy = status === "starting";
  const isLive = status === "running" || status === "starting";
  const info = STATUS_COPY[status];

  const statusLabel =
    status === "exited" && exitCode !== undefined
      ? `Exited (${exitCode})`
      : info.label;

  const memoryPercent = stats?.running
    ? Math.round((stats.memoryBytes / stats.memoryLimitBytes) * 100)
    : 0;

  // Containers used to just disappear at the idle timeout, which looked like
  // the preview breaking. Warn while it is close enough to matter.
  const idleWarning =
    stats?.idleStopInSeconds !== null &&
    stats?.idleStopInSeconds !== undefined &&
    stats.running &&
    stats.idleStopInSeconds <= 5 * 60
      ? stats.idleStopInSeconds
      : null;

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {stats?.running && (
        <Tooltip
          title={
            `Memory ${formatMegabytes(stats.memoryBytes)} of ` +
            `${formatMegabytes(stats.memoryLimitBytes)} · CPU ${stats.cpuPercent.toString()}%` +
            (idleWarning !== null
              ? ` · sleeps in ${formatCountdown(idleWarning)} unless something happens`
              : "")
          }
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontFamily: "var(--rc-mono)",
              // Amber once memory is close enough that an OOM kill is a real
              // possibility — that used to arrive with no warning at all.
              color:
                memoryPercent >= 85
                  ? "var(--rc-red)"
                  : memoryPercent >= 65
                    ? "var(--rc-yellow)"
                    : "var(--rc-text-subtle)",
            }}
          >
            {memoryPercent}% mem
            {idleWarning !== null && (
              <span style={{ color: "var(--rc-yellow)" }}>
                · sleeps in {formatCountdown(idleWarning)}
              </span>
            )}
          </span>
        </Tooltip>
      )}

      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "var(--rc-text-subtle)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: info.color,
            animation: isBusy ? "rc-pulse 1.2s ease-in-out infinite" : undefined,
          }}
        />
        {statusLabel}
      </span>

      <Space.Compact>
        <Tooltip
          title={
            !canEdit
              ? "You have read-only access to this project"
              : isLive
                ? "Stop the dev server"
                : command
                  ? `Run: ${command}`
                  : "Run the project's start command"
          }
        >
          <Button
            size="small"
            type="primary"
            danger={isLive}
            icon={
              isBusy ? (
                <LoadingOutlined />
              ) : isLive ? (
                <BorderOutlined />
              ) : (
                <CaretRightFilled />
              )
            }
            disabled={!editorSocket || !canEdit}
            onClick={() => {
              editorSocket?.emit(isLive ? "runStop" : "runStart");
            }}
          >
            {isLive ? "Stop" : "Run"}
          </Button>
        </Tooltip>

        {/* Restarting meant Stop, wait, Run — and pressing Run too early did
            nothing at all, because the previous run was still shutting down. */}
        <Tooltip title="Restart the dev server">
          <Button
            size="small"
            aria-label="Restart the dev server"
            icon={<ReloadOutlined />}
            disabled={!editorSocket || !canEdit || status === "idle"}
            onClick={() => editorSocket?.emit("runRestart")}
          />
        </Tooltip>
      </Space.Compact>
    </span>
  );
};
