import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Spin, Tooltip, message } from "antd";
import {
  VscAdd,
  VscPackage,
  VscRefresh,
  VscTrash,
} from "react-icons/vsc";
import type { PackageEntry, PackageList } from "@replit-clone/shared";
import {
  addPackageApi,
  listPackagesApi,
  removePackageApi,
} from "../../../apis/packages.ts";

/** How each ecosystem's manifest describes itself, for the pane header. */
const ECOSYSTEM_LABEL = {
  npm: "npm",
  pip: "pip",
  go: "Go modules",
} as const;

interface PackagesPanelProps {
  projectId: string;
  /** Viewers see the list and no way to change it, the same line the editor
   *  and the source-control panel draw. */
  canWrite: boolean;
}

/** The dependency list, and the two things you do to it.
 *
 *  Adding a library previously meant opening a terminal, knowing which package
 *  manager the template uses, and knowing the command. The manifest was already
 *  on disk and nothing in the UI read it.
 */
export const PackagesPanel = ({ projectId, canWrite }: PackagesPanelProps) => {
  const [list, setList] = useState<PackageList | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  /** The name currently being installed or removed, so only its own row shows
   *  a spinner rather than the whole list going blank. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The manager's last output, shown only when something went wrong or the
   *  user asks — an install's full log in a 260px pane is noise. */
  const [output, setOutput] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await listPackagesApi(projectId));
    } catch {
      // A project whose manifest cannot be read is not an error state worth a
      // banner; the empty case below says the same thing more usefully.
      setList({ ecosystem: null, manifest: null, packages: [] });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(() => {
    const packages = list?.packages ?? [];
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? packages.filter((entry) => entry.name.toLowerCase().includes(needle))
      : packages;

    // Runtime dependencies first, then dev, each alphabetical -- the manifest's
    // own order is insertion order, which is not an order anyone reads by.
    return [...matching].sort((a, b) => {
      if (Boolean(a.dev) !== Boolean(b.dev)) return a.dev ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [list, filter]);

  /** Splits "react@19" or "flask>=3" into the two things the API wants.
   *
   *  Typing the version alongside the name is how everyone types an install
   *  command, so the field accepts it rather than demanding two inputs. */
  function parseDraft(raw: string): { name: string; version: string } {
    const trimmed = raw.trim();

    // A scope's leading @ is part of the name, so the separator is looked for
    // after the first character.
    const at = trimmed.indexOf("@", 1);
    if (at > 0) {
      return {
        name: trimmed.slice(0, at),
        version: trimmed.slice(at + 1).trim(),
      };
    }

    const comparator = /[<>=!~^]/.exec(trimmed);
    if (comparator?.index) {
      return {
        name: trimmed.slice(0, comparator.index).trim(),
        version: trimmed.slice(comparator.index).trim(),
      };
    }

    return { name: trimmed, version: "" };
  }

  async function add(dev: boolean) {
    const { name, version } = parseDraft(draft);
    if (!name) return;

    setBusy(name);
    setOutput(null);
    try {
      const result = await addPackageApi(projectId, name, version, dev);
      setList(result.packages);
      setDraft("");
      void message.success(`Installed ${name}`);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "The install failed";
      setOutput(reason);
      void message.error(reason);
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: PackageEntry) {
    setBusy(entry.name);
    setOutput(null);
    try {
      const result = await removePackageApi(projectId, entry.name);
      setList(result.packages);
      void message.success(`Removed ${entry.name}`);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "The removal failed";
      setOutput(reason);
      void message.error(reason);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <Spin />
      </div>
    );
  }

  // No manifest means no package manager owns this project -- the Static HTML
  // template, or a directory someone emptied. Saying so beats an empty list
  // with an add box that could only fail.
  if (!list?.ecosystem) {
    return (
      <div style={{ padding: "24px 16px" }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
              No package.json, requirements.txt or go.mod here, so there are no
              dependencies to manage.
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div className="rc-pane-label">
        <VscPackage size={13} />
        <span style={{ flex: 1 }}>
          {ECOSYSTEM_LABEL[list.ecosystem]}
          <span style={{ opacity: 0.6 }}> · {list.manifest}</span>
        </span>
        <Tooltip title="Reload from the manifest">
          <button
            className="rc-icon-button"
            aria-label="Reload packages"
            onClick={() => void refresh()}
          >
            <VscRefresh size={13} />
          </button>
        </Tooltip>
      </div>

      {canWrite && (
        <div style={{ display: "flex", gap: 6, padding: "0 10px 8px" }}>
          <Input
            size="small"
            value={draft}
            placeholder="package, or package@version"
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => void add(false)}
            disabled={busy !== null}
          />
          <Tooltip title="Install">
            <Button
              size="small"
              aria-label="Install"
              icon={<VscAdd size={12} />}
              loading={busy !== null && draft.trim().length > 0}
              disabled={draft.trim().length === 0}
              onClick={() => void add(false)}
            />
          </Tooltip>
          {list.ecosystem === "npm" && (
            <Tooltip title="Install as a dev dependency">
              <Button
                size="small"
                aria-label="Install as a dev dependency"
                disabled={draft.trim().length === 0}
                onClick={() => void add(true)}
              >
                dev
              </Button>
            </Tooltip>
          )}
        </div>
      )}

      {list.packages.length > 8 && (
        <div style={{ padding: "0 10px 8px" }}>
          <Input
            size="small"
            allowClear
            value={filter}
            placeholder="Filter"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px" }}>
        {shown.length === 0 ? (
          <div
            style={{
              padding: "18px 12px",
              fontSize: 12,
              color: "var(--rc-text-subtle)",
            }}
          >
            {filter ? "Nothing matches that." : "No dependencies yet."}
          </div>
        ) : (
          shown.map((entry) => (
            <div key={entry.name} className="rc-package-row">
              <span className="rc-package-name" title={entry.name}>
                {entry.name}
              </span>
              {entry.dev && <span className="rc-package-dev">dev</span>}
              <span className="rc-package-version" title={entry.version}>
                {entry.version || "latest"}
              </span>
              {canWrite && (
                <Tooltip title={`Remove ${entry.name}`}>
                  <button
                    className="rc-icon-button rc-package-remove"
                    aria-label={`Remove ${entry.name}`}
                    disabled={busy !== null}
                    data-spinning={busy === entry.name}
                    onClick={() => void remove(entry)}
                  >
                    {busy === entry.name ? (
                      <VscRefresh size={12} />
                    ) : (
                      <VscTrash size={12} />
                    )}
                  </button>
                </Tooltip>
              )}
            </div>
          ))
        )}
      </div>

      {output && (
        <pre className="rc-package-output" aria-label="Package manager output">
          {output}
        </pre>
      )}
    </div>
  );
};
