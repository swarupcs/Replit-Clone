import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import {
  getProjectEnvApi,
  getStartCommandApi,
  setProjectEnvApi,
  setStartCommandApi,
} from "../../../apis/projects.ts";
import { DevcontainerSection } from "./DevcontainerSection.tsx";
import { ComposeSection } from "./ComposeSection.tsx";
import { WorkspaceSizeSection } from "./WorkspaceSizeSection.tsx";

interface EnvVarsDialogProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

interface Row {
  /** Stable across re-renders so typing in one row does not remount the others,
   *  which the name alone cannot promise while the name is being edited. */
  key: number;
  name: string;
  value: string;
}

let nextKey = 0;

function toRows(vars: Record<string, string>): Row[] {
  return Object.entries(vars).map(([name, value]) => ({
    key: nextKey++,
    name,
    value,
  }));
}

/** Names the server refuses, repeated here so the user is told before saving. */
const RESERVED = new Set(["HOME", "PATH", "HOSTNAME", "PREVIEW_BASE", "DEV_PORT"]);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function describeProblem(rows: Row[]): string | null {
  const named = rows.filter((row) => row.name.trim().length > 0);

  for (const row of named) {
    const name = row.name.trim();
    if (!NAME_PATTERN.test(name)) return `"${name}" is not a valid name.`;
    if (RESERVED.has(name)) return `${name} is set by the platform.`;
  }

  const names = named.map((row) => row.name.trim());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);

  return duplicate ? `${duplicate} appears twice.` : null;
}

/** Per-project environment variables.
 *
 *  Kept on the project rather than in a dotfile in the working tree, so they
 *  are not committed by the user's own git, not carried into an export, and not
 *  readable through the file tree.
 */
export const EnvVarsDialog = ({ projectId, open, onClose }: EnvVarsDialogProps) => {
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [rows, setRows] = useState<Row[]>([]);
  /** The run command being edited. Empty means the template's default. */
  const [commandDraft, setCommandDraft] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["projectEnv", projectId],
    queryFn: () => getProjectEnvApi(projectId),
    enabled: open,
  });

  const startCommand = useQuery({
    queryKey: ["startCommand", projectId],
    queryFn: () => getStartCommandApi(projectId),
    enabled: open,
  });

  // Seeded from the server each time it opens, so a cancelled edit does not
  // linger into the next one.
  useEffect(() => {
    if (open && data) setRows(toRows(data.vars));
  }, [open, data]);

  useEffect(() => {
    if (open && startCommand.data) {
      setCommandDraft(startCommand.data.command ?? "");
    }
  }, [open, startCommand.data]);

  const saveMutation = useMutation({
    mutationFn: (vars: Record<string, string>) => setProjectEnvApi(projectId, vars),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["projectEnv", projectId] });
      void messageApi.success(
        `Saved ${String(Object.keys(saved).length)} variable${
          Object.keys(saved).length === 1 ? "" : "s"
        }. Restart the dev server for them to take effect.`,
      );
      onClose();
    },
    onError: (error: { response?: { data?: { message?: string } } }) => {
      void messageApi.error(
        error.response?.data?.message ?? "Could not save the variables.",
      );
    },
  });

  const problem = describeProblem(rows);

  function update(key: number, field: "name" | "value", next: string) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: next } : row)),
    );
  }

  const commandMutation = useMutation({
    mutationFn: (command: string) => setStartCommandApi(projectId, command),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["startCommand", projectId] }),
  });

  function save() {
    const vars: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (name) vars[name] = row.value;
    }

    // Saved only when it actually changed: the endpoint writes a row, and
    // opening the dialog to edit a variable should not touch the command.
    if (commandDraft.trim() !== (startCommand.data?.command ?? "")) {
      commandMutation.mutate(commandDraft);
    }

    saveMutation.mutate(vars);
  }

  return (
    <>
      {contextHolder}

      <Modal
        open={open}
        title="Project settings"
        okText="Save"
        onOk={save}
        onCancel={onClose}
        confirmLoading={saveMutation.isPending}
        okButtonProps={{ disabled: problem !== null || isLoading }}
        width={620}
        destroyOnHidden
      >
        {/* First, because it decides the container everything else runs in --
            and because it renders nothing at all for a project without one. */}
        <DevcontainerSection projectId={projectId} enabled={open} />
        <ComposeSection projectId={projectId} enabled={open} />

        {/* Second, for the same reason the devcontainer is first: it decides
            how much machine everything below runs on, and it is the one
            setting here whose wrong value is felt as the editor being slow
            rather than as a thing not working. */}
        <WorkspaceSizeSection projectId={projectId} enabled={open} />

        {/* The run command sits above the variables because it is the thing an
            imported repository most often needs corrected: the template is
            detected from the files, and a real project's own script is not in
            the fixed registry of templates. */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Run command</div>
          <Input
            placeholder={startCommand.data?.templateDefault ?? ""}
            value={commandDraft}
            onChange={(event) => setCommandDraft(event.target.value)}
            style={{ fontFamily: "var(--rc-mono)" }}
          />
          <div
            style={{ marginTop: 6, fontSize: 12, color: "var(--rc-text-subtle)" }}
          >
            {startCommand.data?.command
              ? "This project's own command."
              : `Using the template's default: ${
                  startCommand.data?.templateDefault ?? "…"
                }`}
            {" Clear the box to go back to it."}
          </div>
        </div>

        <div style={{ fontSize: 13, marginBottom: 6 }}>Environment variables</div>
        <Typography.Paragraph
          style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}
        >
          Passed to the container when it starts. Restart the dev server after
          saving for a running process to see them.
        </Typography.Paragraph>

        {/* Shown only when it is NOT true. A banner saying "encrypted" on every
            open would be noise on the servers that are fine and would train
            people to stop reading the one that is not -- and this is the
            field people paste live API keys into, so the warning has to reach
            them before they do it rather than afterwards. */}
        {data && !data.encryptedAtRest && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Not encrypted on this server"
            description={
              "SECRET_ENCRYPTION_KEY is not set, so these values are stored " +
              "in plain text and are readable by anyone who can read the " +
              "database. Set a key and restart to have them sealed."
            }
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((row) => (
            <div key={row.key} style={{ display: "flex", gap: 8 }}>
              <Input
                placeholder="MY_VARIABLE"
                value={row.name}
                onChange={(event) => update(row.key, "name", event.target.value)}
                style={{ flex: "0 0 40%", fontFamily: "var(--rc-mono)" }}
              />
              <Input.Password
                placeholder="value"
                value={row.value}
                onChange={(event) => update(row.key, "value", event.target.value)}
                // Values are often secrets, so they are masked by default with
                // the usual reveal control rather than shown outright.
                visibilityToggle
                style={{ flex: 1, fontFamily: "var(--rc-mono)" }}
              />
              <Button
                type="text"
                aria-label={`Remove ${row.name || "variable"}`}
                icon={<DeleteOutlined />}
                onClick={() =>
                  setRows((current) => current.filter((entry) => entry.key !== row.key))
                }
              />
            </div>
          ))}

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() =>
              setRows((current) => [...current, { key: nextKey++, name: "", value: "" }])
            }
          >
            Add variable
          </Button>

          {problem && (
            <span style={{ color: "var(--rc-red)", fontSize: 13 }}>{problem}</span>
          )}
        </div>
      </Modal>
    </>
  );
};
