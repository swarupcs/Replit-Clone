import { useQuery } from "@tanstack/react-query";
import { Tag } from "antd";
import { VscInfo, VscWarning } from "react-icons/vsc";
import { getDevcontainerApi } from "../../../apis/projects.ts";

interface DevcontainerSectionProps {
  projectId: string;
  /** Only fetched while the dialog is open — this reads a file off disk on the
   *  server, and there is no reason to do that behind a closed dialog. */
  enabled: boolean;
}

/** What the project's `.devcontainer/devcontainer.json` asked for, and what
 *  actually happened.
 *
 *  It lives in project settings because that is where somebody goes when the
 *  container is not what they expected. It renders nothing at all when there is
 *  no devcontainer and nothing went wrong, so the dialog is unchanged for the
 *  projects that do not have one.
 */
export const DevcontainerSection = ({
  projectId,
  enabled,
}: DevcontainerSectionProps) => {
  const { data } = useQuery({
    queryKey: ["devcontainer", projectId],
    queryFn: () => getDevcontainerApi(projectId),
    enabled,
    // The file changes when the user edits it, and they may well have just
    // done so before opening this.
    staleTime: 0,
  });

  if (!data) return null;
  if (!data.config && !data.error) return null;

  const { config } = data;
  const imageMismatch =
    config?.requestedImage !== null &&
    config?.requestedImage !== undefined &&
    data.imageInUse !== null &&
    data.imageInUse !== config.requestedImage;

  return (
    <div className="rc-devcontainer" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Dev container
        {config && (
          <span
            style={{
              marginLeft: 8,
              fontFamily: "var(--rc-mono)",
              fontSize: 12,
              color: "var(--rc-text-subtle)",
            }}
          >
            {config.source}
          </span>
        )}
      </div>

      {data.error && (
        <div className="rc-devcontainer-problem" role="alert">
          <VscWarning size={13} aria-hidden />
          <span>{data.error}</span>
        </div>
      )}

      {config && (
        <div className="rc-devcontainer-facts">
          <dl>
            <dt>Image</dt>
            <dd>
              {data.imageInUse ?? config.requestedImage ?? "the template's"}
              {imageMismatch && (
                <Tag
                  color="warning"
                  style={{ marginLeft: 6, fontSize: 11, lineHeight: "16px" }}
                >
                  restart to apply
                </Tag>
              )}
            </dd>

            {config.forwardPorts.length > 0 && (
              <>
                <dt>Ports</dt>
                <dd>{config.forwardPorts.join(", ")}</dd>
              </>
            )}

            {config.workspaceFolder && (
              <>
                <dt>Folder</dt>
                <dd>{config.workspaceFolder}</dd>
              </>
            )}

            {config.containerEnvNames.length > 0 && (
              <>
                <dt>Variables</dt>
                {/* Names only. The server does not send the values back: they
                    are the user's own, and they are also the shape a secret
                    takes. */}
                <dd>{config.containerEnvNames.join(", ")}</dd>
              </>
            )}

            {(config.postCreateCommand.length > 0 ||
              config.postStartCommand.length > 0) && (
              <>
                <dt>Setup</dt>
                <dd>
                  {[...config.postCreateCommand, ...config.postStartCommand].join(
                    " ; ",
                  )}
                  {data.running && (
                    <Tag
                      color="processing"
                      style={{ marginLeft: 6, fontSize: 11, lineHeight: "16px" }}
                    >
                      running
                    </Tag>
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      {config && config.unsupported.length > 0 && (
        <div className="rc-devcontainer-unsupported">
          <div className="rc-devcontainer-unsupported-head">
            <VscInfo size={13} aria-hidden />
            <span>
              {config.unsupported.length === 1
                ? "One setting was not applied"
                : `${String(config.unsupported.length)} settings were not applied`}
            </span>
          </div>
          <ul>
            {config.unsupported.map((entry) => (
              <li key={entry.key}>
                <code>{entry.key}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.lifecycleLog && (
        <pre className="rc-devcontainer-log" aria-label="Dev container setup output">
          {data.lifecycleLog}
        </pre>
      )}
    </div>
  );
};
