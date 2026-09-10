import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Typography, message } from "antd";
import {
  getTimelineApi,
  getTimelineVersionApi,
  type TimelineEntry,
} from "../../../apis/projects.ts";
import { useCompareStore } from "../../../store/compareStore.ts";

/** What this file looked like earlier. plan.md §10.12.
 *
 *  The snapshots have been taken on every save since §2.x — automatically, per
 *  file, from the write handler. Nothing could read them: the service had no
 *  route and no UI, so the answer to "what did this look like an hour ago" was
 *  on disk and unreachable. This is the reading half.
 *
 *  **Opening a version puts it in the diff pane rather than replacing the
 *  file.** §10.11 made the left-hand side a choice a fortnight of rows ago, so
 *  the useful thing to do with an old version is show it against what is there
 *  now — and the thing somebody actually wants is usually three lines out of
 *  it, not the whole file back.
 */
export function TimelinePanel({
  projectId,
  relPath,
}: {
  projectId: string;
  relPath: string | null;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const { setAgainst, setLeft } = useCompareStore();

  const load = useCallback(async () => {
    if (!relPath) {
      setEntries([]);
      return;
    }
    try {
      setEntries(await getTimelineApi(projectId, relPath));
    } catch {
      // A file with no saves yet is the ordinary case.
      setEntries([]);
    }
  }, [projectId, relPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (at: number): Promise<void> => {
    if (!relPath) return;
    setBusy(at);
    try {
      const contents = await getTimelineVersionApi(projectId, relPath, at);
      setAgainst({ kind: "file", relPath: `${relPath} @ ${when(at)}` });
      setLeft(contents, false);
    } catch {
      // Pruned away between listing and opening. The service keeps a bounded
      // number, so this is a thing that legitimately happens.
      void message.error("That version is no longer kept");
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (!relPath) {
    return (
      <Empty
        image={null}
        description={
          <span style={{ fontSize: 12.5, color: "var(--rc-text-subtle)" }}>
            Open a file to see its history.
          </span>
        }
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, padding: 8, overflowY: "auto" }}>
      <Typography.Text style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
        Saved versions of {relPath}. Kept on this machine beside the project —
        useful for the last hour, not a backup.
      </Typography.Text>

      {entries.length === 0 ? (
        <Empty
          image={null}
          description={
            <span style={{ fontSize: 12.5, color: "var(--rc-text-subtle)" }}>
              No earlier versions yet. One is kept each time you save.
            </span>
          }
        />
      ) : (
        entries.map((entry) => (
          <div
            key={entry.at}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}
          >
            <span style={{ flex: 1 }}>{when(entry.at)}</span>
            <span style={{ color: "var(--rc-text-subtle)", fontSize: 11.5 }}>
              {formatBytes(entry.bytes)}
            </span>
            <Button
              size="small"
              loading={busy === entry.at}
              aria-label={`Compare with ${when(entry.at)}`}
              onClick={() => {
                void open(entry.at);
              }}
            >
              Compare
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

/** Relative for anything recent, absolute after that.
 *
 *  "12 minutes ago" is the answer to the question this panel exists for; a
 *  timestamp is the answer once the question becomes "which day". */
function when(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))} h ago`;
  return new Date(at).toLocaleString();
}

function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${String(bytes)} B`
    : `${String(Math.round(bytes / 1024))} KB`;
}

export default TimelinePanel;
