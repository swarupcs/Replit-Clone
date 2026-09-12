import { useMemo, useState } from "react";
import { Alert, Badge, Button, Empty, Select, Table, Tabs, Tag, Typography } from "antd";
import type { ConsoleLevel, ErrorRecord } from "@replit-clone/shared";
import {
  selectLatestError,
  useDevtoolsStore,
} from "../../../store/devtoolsStore.ts";
import { DEVICE_PRESETS } from "../../../lib/previewBridge.ts";

/** Devtools for the thing being previewed. plan.md §13.5.
 *
 *  The row's sharpest user is "the person the preview is shared with, who cannot
 *  open devtools on somebody else's page and would not know to" — so this is a
 *  panel in the app rather than a suggestion to press F12.
 */

const LEVEL_COLOUR: Record<ConsoleLevel, string | undefined> = {
  error: "red",
  warn: "orange",
  info: "blue",
  debug: undefined,
  log: undefined,
};

function time(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/** The error overlay, which is the third of the row's four things.
 *
 *  Over the preview rather than in a tab, because a blank iframe with the
 *  explanation filed under a tab nobody opened is exactly the situation the row
 *  describes: the reader concludes the project is broken.
 */
export function PreviewErrorOverlay({ onDismiss }: { onDismiss: () => void }) {
  const latest = useDevtoolsStore(selectLatestError);
  const [dismissed, setDismissed] = useState<number | null>(null);

  if (!latest || dismissed === latest.at) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0, 0, 0, 0.72)",
        padding: 16,
        overflow: "auto",
        zIndex: 5,
      }}
    >
      <Alert
        type="error"
        showIcon
        message={latest.rejection ? "Unhandled promise rejection" : "Runtime error"}
        description={<ErrorBody record={latest} />}
        action={
          <Button
            size="small"
            onClick={() => {
              setDismissed(latest.at);
              onDismiss();
            }}
          >
            Dismiss
          </Button>
        }
      />
    </div>
  );
}

function ErrorBody({ record }: { record: ErrorRecord }) {
  const where =
    record.source === undefined
      ? undefined
      : `${record.source}${record.line === undefined ? "" : `:${String(record.line)}`}`;

  return (
    <div>
      <Typography.Paragraph style={{ marginBottom: where ? 4 : 0 }}>
        {record.message}
      </Typography.Paragraph>
      {where !== undefined && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {where}
        </Typography.Text>
      )}
      {record.stack !== undefined && (
        <pre style={{ fontSize: 11, marginTop: 8, whiteSpace: "pre-wrap", marginBottom: 0 }}>
          {record.stack}
        </pre>
      )}
    </div>
  );
}

/** The size picker. Sizes and not device names, because this frames the iframe
 *  and does not emulate a phone — no pixel ratio, no user-agent string. */
export function DeviceSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select
      size="small"
      value={value}
      onChange={onChange}
      style={{ minWidth: 160 }}
      options={DEVICE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
    />
  );
}

export function DevtoolsPanel() {
  const consoleRows = useDevtoolsStore((state) => state.console);
  const networkRows = useDevtoolsStore((state) => state.network);
  const errors = useDevtoolsStore((state) => state.errors);
  const dropped = useDevtoolsStore((state) => state.dropped);
  const clear = useDevtoolsStore((state) => state.clear);

  const [level, setLevel] = useState<"all" | ConsoleLevel>("all");

  const filtered = useMemo(
    () => (level === "all" ? consoleRows : consoleRows.filter((row) => row.level === level)),
    [consoleRows, level],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Tabs
        size="small"
        tabBarExtraContent={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {dropped > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dropped.toLocaleString()} dropped
              </Typography.Text>
            )}
            <Button size="small" onClick={clear}>
              Clear
            </Button>
          </div>
        }
        items={[
          {
            key: "console",
            label: (
              <Badge count={errors.length} size="small" offset={[8, -2]}>
                Console
              </Badge>
            ),
            children: (
              <div style={{ overflow: "auto", maxHeight: 260 }}>
                <div style={{ marginBottom: 8 }}>
                  <Select
                    size="small"
                    value={level}
                    onChange={setLevel}
                    style={{ minWidth: 120 }}
                    options={[
                      { value: "all", label: "All levels" },
                      { value: "error", label: "Errors" },
                      { value: "warn", label: "Warnings" },
                      { value: "info", label: "Info" },
                      { value: "log", label: "Logs" },
                      { value: "debug", label: "Debug" },
                    ]}
                  />
                </div>
                {filtered.length === 0 ? (
                  <Empty
                    image={null}
                    description="Nothing logged yet. Run the preview and its console appears here."
                  />
                ) : (
                  filtered.map((row, index) => (
                    <div
                      key={`${String(row.at)}-${String(index)}`}
                      style={{
                        display: "flex",
                        gap: 8,
                        padding: "2px 0",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {time(row.at)}
                      </Typography.Text>
                      {LEVEL_COLOUR[row.level] !== undefined && (
                        <Tag color={LEVEL_COLOUR[row.level]} style={{ marginInlineEnd: 0 }}>
                          {row.level}
                        </Tag>
                      )}
                      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {row.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ),
          },
          {
            key: "network",
            label: "Network",
            children: (
              <Table
                size="small"
                rowKey={(row) => `${String(row.at)}-${row.url}`}
                dataSource={networkRows}
                pagination={false}
                scroll={{ y: 220, x: true }}
                locale={{
                  emptyText: "No requests yet.",
                }}
                columns={[
                  { title: "Method", dataIndex: "method", width: 90 },
                  {
                    title: "URL",
                    dataIndex: "url",
                    ellipsis: true,
                    render: (url: string) => (
                      <span style={{ fontFamily: "monospace", fontSize: 12 }}>{url}</span>
                    ),
                  },
                  {
                    title: "Status",
                    dataIndex: "status",
                    width: 90,
                    render: (status: number | undefined, row) => (
                      <Tag color={row.failed ? "red" : "green"}>
                        {status === undefined ? "failed" : status}
                      </Tag>
                    ),
                  },
                  {
                    title: "Time",
                    dataIndex: "ms",
                    width: 90,
                    render: (ms: number) => `${String(ms)} ms`,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
