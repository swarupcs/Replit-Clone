import { useQuery } from "@tanstack/react-query";
import { Tag } from "antd";
import { VscInfo, VscWarning } from "react-icons/vsc";
import { getComposeApi } from "../../../apis/projects.ts";

interface ComposeSectionProps {
  projectId: string;
  /** Only fetched while the dialog is open — this reads a file off disk on the
   *  server, and there is no reason to do that behind a closed dialog. */
  enabled: boolean;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  running: { color: "success", label: "running" },
  stopped: { color: "default", label: "stopped" },
  absent: { color: "default", label: "not started" },
  refused: { color: "warning", label: "not run here" },
};

/** What the project's own `docker-compose.yml` declares, and what is running.
 *
 *  plan.md §11.3. It lives beside the dev container section for the same
 *  reason that one does: this is where somebody goes when the container is not
 *  what they expected, and "my app cannot reach its database" is exactly that
 *  question. It renders nothing at all when the project has no compose file,
 *  so the dialog is unchanged for every project that does not.
 */
export const ComposeSection = ({ projectId, enabled }: ComposeSectionProps) => {
  const { data } = useQuery({
    queryKey: ["compose", projectId],
    queryFn: () => getComposeApi(projectId),
    enabled,
    // The user edits this file in the editor behind this dialog, and may well
    // have just done so.
    staleTime: 0,
  });

  if (!data) return null;
  if (!data.source && !data.error) return null;

  return (
    <div className="rc-devcontainer" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Services
        {data.source && (
          <span
            style={{
              marginLeft: 8,
              fontFamily: "var(--rc-mono)",
              fontSize: 12,
              color: "var(--rc-text-subtle)",
            }}
          >
            {data.source}
          </span>
        )}
      </div>

      {data.error && (
        <div className="rc-devcontainer-problem" role="alert">
          <VscWarning size={13} aria-hidden />
          <span>{data.error}</span>
        </div>
      )}

      {/* Said once, at the top, rather than repeated as a refusal on every
          service: the file is fine and the deployment is the answer. */}
      {!data.enabled && data.services.length > 0 && (
        <div className="rc-devcontainer-problem" role="note">
          <VscInfo size={13} aria-hidden />
          <span>
            This deployment does not start compose services. The file is read
            and shown here, and nothing is run from it.
          </span>
        </div>
      )}

      {data.services.length > 0 && (
        <div className="rc-devcontainer-facts">
          <dl>
            {data.services.map((service) => (
              <div key={service.name} style={{ display: "contents" }}>
                <dt>{service.name}</dt>
                <dd>
                  {service.image}
                  <Tag
                    color={STATUS_TAG[service.status]?.color}
                    style={{ marginLeft: 6, fontSize: 11, lineHeight: "16px" }}
                  >
                    {STATUS_TAG[service.status]?.label}
                  </Tag>
                  {/* The useful sentence. Nothing is published to the host, so
                      the only way to reach one of these is by service name from
                      the project's own container — which is exactly what the
                      compose file already told the app to do. */}
                  {service.ports.length > 0 && service.status === "running" && (
                    <div
                      style={{
                        fontFamily: "var(--rc-mono)",
                        fontSize: 12,
                        color: "var(--rc-text-subtle)",
                      }}
                    >
                      {service.ports
                        .map((port) => `${service.name}:${String(port)}`)
                        .join("  ")}
                    </div>
                  )}
                  {service.refusal && (
                    <div style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
                      {service.refusal}
                    </div>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Named rather than listed as a service, so it does not read as one that
          was silently dropped: this project's own container is that service. */}
      {data.appService && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--rc-text-subtle)" }}>
          <code>{data.appService}</code> builds from this repository, so this
          project&rsquo;s own container is that service. It is not started twice.
        </p>
      )}

      {data.unsupported.length > 0 && (
        <div className="rc-devcontainer-unsupported">
          <div className="rc-devcontainer-unsupported-head">
            <VscInfo size={13} aria-hidden />
            <span>
              {data.unsupported.length === 1
                ? "One setting was not applied"
                : `${String(data.unsupported.length)} settings were not applied`}
            </span>
          </div>
          <ul>
            {data.unsupported.map((entry) => (
              <li key={`${entry.key}:${entry.reason}`}>
                <code>{entry.key}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
