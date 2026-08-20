import { Button, Tooltip } from "antd";
import {
  CaretRightFilled,
  LoadingOutlined,
  BorderOutlined,
} from "@ant-design/icons";
import type { RunStatus } from "@replit-clone/shared";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
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
export const RunControl = () => {
  const { editorSocket } = useEditorSocketStore();
  const { status, exitCode, command } = useRunStore((store) => store.state);

  const isBusy = status === "starting";
  const isLive = status === "running" || status === "starting";
  const info = STATUS_COPY[status];

  const statusLabel =
    status === "exited" && exitCode !== undefined
      ? `Exited (${exitCode})`
      : info.label;

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
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

      <Tooltip
        title={
          isLive
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
          disabled={!editorSocket}
          onClick={() => {
            editorSocket?.emit(isLive ? "runStop" : "runStart");
          }}
        >
          {isLive ? "Stop" : "Run"}
        </Button>
      </Tooltip>
    </span>
  );
};
