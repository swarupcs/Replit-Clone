import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useRunStore } from "../../../store/runStore.ts";
import {
  selectVisibleStatus,
  useEditorStatusStore,
} from "../../../store/editorStatusStore.ts";
import {
  selectErrorCount,
  selectWarningCount,
  useProblemsStore,
} from "../../../store/problemsStore.ts";
import type { RunStatus } from "@replit-clone/shared";

/** What the run state should read as, and in what colour. `idle` says nothing:
 *  a project nobody has started yet is the ordinary case, and a chip for it
 *  would be noise on every fresh page. */
const RUN: Partial<Record<RunStatus, { label: string; colour: string }>> = {
  starting: { label: "Starting", colour: "var(--rc-yellow)" },
  running: { label: "Running", colour: "var(--rc-green)" },
  exited: { label: "Stopped", colour: "var(--rc-text-subtle)" },
};

/** The app's one status bar.
 *
 *  It was rendered by `EditorComponent`, which meant a split gave you two of
 *  them and closing every tab left you with none. Owned by the playground now,
 *  it survives both, and it is the place where state that belongs to the
 *  project rather than to a file — the run — has somewhere to live.
 */
export const StatusBar = () => {
  const focusedPane = useOpenTabsStore((state) => state.focusedPane);
  const status = useEditorStatusStore(selectVisibleStatus(focusedPane));
  const runStatus = useRunStore((state) => state.state.status);
  const errors = useProblemsStore(selectErrorCount);
  const warnings = useProblemsStore(selectWarningCount);

  const run = RUN[runStatus];

  return (
    <div className="rc-statusbar">
      <span className="rc-statusbar-group">
        {status ? (
          <>
            <span title="Line and column">
              Ln {status.line}, Col {status.column}
            </span>
            {status.selectionCount > 0 && (
              <span>({status.selectionCount} selected)</span>
            )}
          </>
        ) : (
          // With no file open there is no cursor to report, but the bar itself
          // stays: it is the app's, not the editor's.
          <span style={{ opacity: 0.7 }}>No file open</span>
        )}
      </span>

      <span className="rc-statusbar-group">
        {/* Always shown, zeroes included: "0 problems" is information, and a
            count that appears only when something is wrong cannot be trusted
            to be absent for the right reason. */}
        <span
          title="Problems — syntax and schema only"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <span style={{ color: errors > 0 ? "var(--rc-red)" : undefined }}>
            ⨉ {errors}
          </span>
          <span style={{ color: warnings > 0 ? "var(--rc-yellow)" : undefined }}>
            ⚠ {warnings}
          </span>
        </span>

        {run && (
          <span
            title={`Dev server: ${run.label.toLowerCase()}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: run.colour,
              }}
            />
            {run.label}
          </span>
        )}

        {status && (
          <>
            <span>Spaces: {status.tabSize}</span>
            <span>UTF-8</span>
            {status.language && (
              <span style={{ textTransform: "capitalize" }}>
                {status.language}
              </span>
            )}
            <span
              data-dirty={status.isDirty || status.writeError !== null}
              className="rc-statusbar-save"
              title={
                status.writeError ??
                (status.isDirty
                  ? "Unsaved changes — autosaves shortly, or press Ctrl+S"
                  : "All changes saved")
              }
            >
              {!status.canEdit
                ? "Read-only"
                : status.writeError
                  ? "Too large"
                  : status.shared
                    ? "Shared"
                    : status.isDirty
                      ? "Unsaved"
                      : "Saved"}
            </span>
          </>
        )}
      </span>
    </div>
  );
};
