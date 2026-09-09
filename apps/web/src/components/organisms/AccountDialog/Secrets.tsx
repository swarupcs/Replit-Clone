import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Typography, message } from "antd";
import { VscAdd, VscTrash } from "react-icons/vsc";
import type { AccountSecrets } from "@replit-clone/shared";
import {
  getAccountSecretsApi,
  setAccountSecretsApi,
} from "../../../apis/projects.ts";

/** Variables that belong to you rather than to one project. plan.md §13.8.
 *
 *  Beside Identity rather than inside it, and the split is the same one that
 *  panel already makes: Identity is what makes a container LOOK like your
 *  machine — your shell, your commits. This is what it can REACH. Both follow
 *  you around, which is why they share a dialog and not a panel.
 *
 *  The one thing this screen exists to say, beyond editing a list, is who else
 *  can see these. It goes into every container of every project you own, an
 *  editor on a shared project can run `env`, and that sentence is worth
 *  nothing in the abstract — so the count of shared projects is rendered as a
 *  number, in the warning, and only when it is not zero.
 */

interface Row {
  /** Stable across renders so an input does not lose focus when a name above
   *  it is edited. A name cannot be the key: it changes as somebody types. */
  id: number;
  name: string;
  value: string;
}

let nextRowId = 0;

function toRows(vars: Record<string, string>): Row[] {
  return Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ id: (nextRowId += 1), name, value }));
}

function toVars(rows: Row[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) vars[name] = row.value;
  }
  return vars;
}

export function Secrets() {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data, isLoading, error } = useQuery<AccountSecrets>({
    queryKey: ["accountSecrets"],
    queryFn: getAccountSecretsApi,
    retry: false,
  });

  useEffect(() => {
    // Only until somebody starts typing. Refetching under a half-finished edit
    // and replacing it would lose a value they cannot get back by undoing.
    if (data && !dirty) setRows(toRows(data.vars));
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => setAccountSecretsApi(toVars(rows)),
    onSuccess: (next) => {
      setDirty(false);
      setRows(toRows(next.vars));
      queryClient.setQueryData(["accountSecrets"], next);
      void message.success("Saved");
    },
    onError: (failure: Error) => {
      void message.error(failure.message);
    },
  });

  const edit = (id: number, patch: Partial<Row>): void => {
    setDirty(true);
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  if (error) {
    return <Empty description="Could not load your secrets." />;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
        These are added to every container of every project you own. A project
        that sets the same name uses its own value.
      </Typography.Paragraph>

      {data && !data.encryptedAtRest && (
        <Alert
          type="warning"
          showIcon
          message="Not encrypted at rest"
          description="SECRET_ENCRYPTION_KEY is not set on this server, so these are stored in plain text and are readable by anybody who can read the database."
        />
      )}

      {/* Only when it is true. A standing warning about sharing on an account
          that has shared nothing is a warning people learn to skip, and this
          one has to still be readable on the day it matters. */}
      {data && data.sharedProjects > 0 && (
        <Alert
          type="info"
          showIcon
          message={`${String(data.sharedProjects)} of your projects ${
            data.sharedProjects === 1 ? "is" : "are"
          } shared`}
          description="Anyone you have given editor access to can read a container's environment, so they can read these. Keep a key that should not be shared on the project that needs it instead."
        />
      )}

      {isLoading ? (
        <span className="rc-skeleton" style={{ height: 80 }} aria-hidden="true" />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.length === 0 && (
            <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
              Nothing yet. Add a key you use in more than one project.
            </Typography.Text>
          )}

          {rows.map((row) => (
            <div key={row.id} style={{ display: "flex", gap: 8 }}>
              <Input
                aria-label="Name"
                placeholder="MY_VARIABLE"
                value={row.name}
                onChange={(event) => {
                  edit(row.id, { name: event.target.value });
                }}
                style={{ flex: "0 0 220px", fontFamily: "monospace" }}
              />
              {/* A password input, so a shoulder or a screen share does not
                  read every key at once. Revealable, because somebody has to
                  be able to check what is stored. */}
              <Input.Password
                aria-label={`Value for ${row.name || "new variable"}`}
                placeholder="value"
                value={row.value}
                onChange={(event) => {
                  edit(row.id, { value: event.target.value });
                }}
                style={{ flex: 1, fontFamily: "monospace" }}
              />
              <Button
                aria-label={`Remove ${row.name || "this variable"}`}
                icon={<VscTrash />}
                onClick={() => {
                  setDirty(true);
                  setRows((current) => current.filter((entry) => entry.id !== row.id));
                }}
              />
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <Button
              icon={<VscAdd />}
              onClick={() => {
                setDirty(true);
                setRows((current) => [
                  ...current,
                  { id: (nextRowId += 1), name: "", value: "" },
                ]);
              }}
            >
              Add
            </Button>
            <Button
              type="primary"
              loading={save.isPending}
              disabled={!dirty}
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
      >
        A container keeps the environment it was built with, so a project that
        is already running picks these up when it next restarts.
      </Typography.Paragraph>
    </div>
  );
}

export default Secrets;
