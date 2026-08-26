import { useMemo } from "react";
import type { ReactNode } from "react";
import { VscError, VscInfo, VscWarning } from "react-icons/vsc";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useProblemsStore, type Problem } from "../../../store/problemsStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

const ICON: Record<Problem["severity"], { node: ReactNode; label: string }> = {
  error: { node: <VscError size={13} color="var(--rc-red)" />, label: "Error" },
  warning: {
    node: <VscWarning size={13} color="var(--rc-yellow)" />,
    label: "Warning",
  },
  info: { node: <VscInfo size={13} color="var(--rc-text-subtle)" />, label: "Info" },
};

interface FileProblems {
  relPath: string;
  name: string;
  problems: Problem[];
}

/** Grouped by file, in the order the problems already arrive in. */
function groupByFile(problems: Problem[]): FileProblems[] {
  const groups = new Map<string, FileProblems>();

  for (const problem of problems) {
    const existing = groups.get(problem.relPath);
    if (existing) {
      existing.problems.push(problem);
      continue;
    }

    groups.set(problem.relPath, {
      relPath: problem.relPath,
      name: problem.relPath.split("/").pop() ?? problem.relPath,
      problems: [problem],
    });
  }

  return [...groups.values()];
}

/** The diagnostics Monaco has already computed.
 *
 *  They existed and went nowhere: the only way to find one was to scroll the
 *  file until something was underlined.
 */
export const ProblemsPanel = () => {
  const problems = useProblemsStore((state) => state.problems);
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const groups = useMemo(() => groupByFile(problems), [problems]);

  /** Opens the file and asks the editor to put the cursor on the problem —
   *  the same two calls a search result makes, since it is the same journey. */
  function open(problem: Problem) {
    useOpenTabsStore
      .getState()
      .requestReveal(problem.relPath, problem.line, problem.column);
    editorSocket?.emit("readFile", { relPath: problem.relPath });
  }

  if (problems.length === 0) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          padding: 24,
          fontSize: 12.5,
          color: "var(--rc-text-subtle)",
          textAlign: "center",
        }}
      >
        <div>
          No problems detected.
          {/* Said plainly: a clean list here does not mean the project type
              checks, and letting anyone believe it did would be worse than
              having no panel. Semantic validation is off by design — see
              `lib/projectSources.ts`. */}
          <div style={{ marginTop: 6, opacity: 0.75 }}>
            Syntax and schema only — type errors come from the project&rsquo;s own
            check.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", paddingBottom: 8 }}>
      {groups.map((group) => (
        <div key={group.relPath} style={{ marginBottom: 6 }}>
          <div
            className="rc-tree-row"
            style={{ paddingLeft: 12, cursor: "default" }}
            title={group.relPath}
          >
            <FileIcon extension={fileExtension(group.name)} name={group.name} />
            <span style={{ fontWeight: 500 }}>{group.name}</span>
            <span
              style={{
                marginLeft: "auto",
                marginRight: 10,
                fontSize: 11,
                color: "var(--rc-text-subtle)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {group.problems.length}
            </span>
          </div>

          {group.problems.map((problem) => (
            <button
              key={`${problem.line}:${problem.column}:${problem.message}`}
              type="button"
              className="rc-tree-row rc-row-button"
              style={{ paddingLeft: 28, alignItems: "flex-start" }}
              onClick={() => {
                open(problem);
              }}
              title={`${problem.relPath}:${String(problem.line)}`}
            >
              <span
                aria-label={ICON[problem.severity].label}
                style={{ display: "flex", flex: "none", marginTop: 2 }}
              >
                {ICON[problem.severity].node}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                {problem.message}
              </span>
              <span
                style={{
                  flex: "none",
                  fontFamily: "var(--rc-mono)",
                  fontSize: 11,
                  color: "var(--rc-text-subtle)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {problem.source ? `${problem.source} · ` : ""}
                {problem.line}:{problem.column}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};
