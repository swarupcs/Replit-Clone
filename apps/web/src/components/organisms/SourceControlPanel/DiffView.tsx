import { useEffect, useState } from "react";
import { Spin } from "antd";
import { getGitDiffApi } from "../../../apis/projects.ts";
import { parseUnifiedDiff } from "../../../utils/parseUnifiedDiff.ts";
import type { DiffLine } from "../../../utils/parseUnifiedDiff.ts";

interface Props {
  projectId: string;
  path: string;
  /** Which side of the index to diff: staged-vs-HEAD, or worktree-vs-index. */
  staged: boolean;
}

const COLOUR: Record<DiffLine["kind"], string | undefined> = {
  add: "rgba(74, 222, 128, 0.12)",
  remove: "rgba(248, 113, 113, 0.12)",
  context: undefined,
  meta: undefined,
};

const MARKER: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
  meta: "\\",
};

/** Fixed-width gutter so the code column starts at the same x on every row,
 *  whatever the line numbers are. */
function gutter(value: number | undefined) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 34,
        paddingRight: 6,
        textAlign: "right",
        color: "var(--rc-text-subtle)",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {value ?? ""}
    </span>
  );
}

/** The patch for one changed file, rendered inline in the panel.
 *
 *  A unified patch rather than Monaco's side-by-side diff: git hands us a
 *  patch, the sidebar is too narrow for two columns, and reconstructing both
 *  full files just to feed a diff editor would need two more round trips.
 */
export function DiffView({ projectId, path, staged }: Props) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setPatch(null);
    setError(null);

    getGitDiffApi(projectId, path, staged)
      .then((next) => {
        if (!cancelled) setPatch(next);
      })
      .catch(() => {
        // The file can go away between the status listing and this request.
        if (!cancelled) setError("Could not load the diff");
      });

    return () => {
      // The path can change while a request is in flight; a late answer for the
      // previous file must not overwrite the current one.
      cancelled = true;
    };
  }, [projectId, path, staged]);

  if (error) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--rc-red)" }}>
        {error}
      </div>
    );
  }

  if (patch === null) {
    return (
      <div style={{ padding: "12px", textAlign: "center" }}>
        <Spin size="small" />
      </div>
    );
  }

  const parsed = parseUnifiedDiff(patch);

  if (parsed.binary) {
    return (
      <div
        style={{ padding: "8px 12px", fontSize: 12, color: "var(--rc-text-muted)" }}
      >
        Binary file — nothing to show.
      </div>
    );
  }

  if (parsed.hunks.length === 0) {
    return (
      <div
        style={{ padding: "8px 12px", fontSize: 12, color: "var(--rc-text-muted)" }}
      >
        No changes to show.
      </div>
    );
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--rc-border)",
        borderBottom: "1px solid var(--rc-border)",
        background: "var(--rc-surface-sunken)",
        maxHeight: 320,
        overflow: "auto",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 11.5,
        lineHeight: "17px",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: "5px 12px",
          fontSize: 11,
          color: "var(--rc-text-muted)",
          position: "sticky",
          top: 0,
          background: "var(--rc-surface-sunken)",
          borderBottom: "1px solid var(--rc-border)",
        }}
      >
        <span style={{ color: "var(--rc-green)" }}>+{parsed.additions}</span>
        <span style={{ color: "var(--rc-red)" }}>−{parsed.deletions}</span>
      </div>

      {parsed.hunks.map((hunk) => (
        <div key={hunk.header}>
          <div
            style={{
              padding: "3px 12px",
              color: "var(--rc-text-subtle)",
              background: "rgba(167, 139, 250, 0.06)",
            }}
          >
            {hunk.header}
          </div>

          {hunk.lines.map((line, index) => (
            <div
              // Index is stable here: a hunk's lines are only ever re-rendered
              // wholesale, never inserted into.
              key={`${hunk.header}:${String(index)}`}
              style={{
                display: "flex",
                background: COLOUR[line.kind],
                whiteSpace: "pre",
              }}
            >
              {gutter(line.oldLine)}
              {gutter(line.newLine)}
              <span
                style={{
                  width: 12,
                  flexShrink: 0,
                  color: "var(--rc-text-subtle)",
                  userSelect: "none",
                }}
              >
                {MARKER[line.kind]}
              </span>
              <span
                style={{
                  flex: 1,
                  color:
                    line.kind === "meta"
                      ? "var(--rc-text-subtle)"
                      : "var(--rc-text)",
                  fontStyle: line.kind === "meta" ? "italic" : undefined,
                }}
              >
                {line.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
