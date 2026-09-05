import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useRunStore } from "../../../store/runStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { PresenceStack } from "../PresenceStack/PresenceStack.tsx";
import { PortsStatus } from "../PortsStatus/PortsStatus.tsx";
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
/** `projectId` is optional because the bar is the app's, not the route's: it
 *  renders before the route param has resolved, and everything else in it is
 *  about the editor rather than the project. */
export const StatusBar = ({ projectId }: { projectId?: string }) => {
  const focusedPane = useOpenTabsStore((state) => state.focusedPane);
  const status = useEditorStatusStore(selectVisibleStatus(focusedPane));
  const runStatus = useRunStore((state) => state.state.status);
  const errors = useProblemsStore(selectErrorCount);
  const warnings = useProblemsStore(selectWarningCount);
  const externallyChanged = useEditorSocketStore(
    (state) => state.externallyChanged,
  );
  const clearExternallyChanged = useEditorSocketStore(
    (state) => state.clearExternallyChanged,
  );

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

        {/* Beside the cursor rather than at the far end: who else is here is
            about the project, and this is the end of the bar people read. */}
        <PresenceStack />
      </span>

      <span className="rc-statusbar-group">
        {/* Persistent state, so a chip rather than a banner: it describes how
            the project is right now, it stays until it is not true any more,
            and it does not resize the editor to say so. */}
        {externallyChanged.length > 0 && (
          <span
            title={
              `${externallyChanged.join(", ")} changed on disk while open. ` +
              "Your version is still what will be saved — close and reopen a " +
              "file to take the version on disk instead."
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--rc-yellow)",
            }}
          >
            {externallyChanged.length} changed on disk
            <button
              type="button"
              className="rc-icon-button"
              aria-label="Dismiss the changed-on-disk notice"
              style={{ width: 14, height: 14, color: "inherit" }}
              onClick={clearExternallyChanged}
            >
              ×
            </button>
          </span>
        )}

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

        {/* Before the run chip, so "Running" and where it is reachable read as
            one thought. Renders nothing at all unless the server is publishing
            to the host — see PortsStatus. */}
        {projectId !== undefined && <PortsStatus projectId={projectId} />}

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
