import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "antd";
import { VscRadioTower } from "react-icons/vsc";
import { getProjectPorts } from "../../../apis/projects.ts";

/** Where this project's ports are reachable from outside the container.
 *
 *  The problem it solves. In development on Windows and macOS the server
 *  publishes each container port on a RANDOM loopback port, because Docker
 *  Desktop gives the host no route to a container's IP. The preview iframe
 *  never needs that number — it goes through `/preview/:projectId/`, which
 *  resolves the mapping server-side and is the same URL in production. But
 *  curl, Postman, a REST client and a second browser tab are not the preview,
 *  and for them the number is the only way in. It changes whenever the
 *  container is recreated, and until now it was written down nowhere a user
 *  could see: `npm start` said "listening on 3000" and nothing anywhere agreed.
 *
 *  In the status bar rather than the preview toolbar, which also shows the
 *  address for the port it happens to be displaying. This is about the project,
 *  it is wanted while looking at the terminal that just printed a port, and the
 *  preview pane is often closed at exactly that moment.
 *
 *  It renders at all ONLY when the server sends addresses, which it does only
 *  when it is publishing on loopback. A deployment publishes nothing to the
 *  host, sends no addresses, and this disappears — no build flag, no
 *  environment check, nothing for a refactor to get wrong. That matters more
 *  than it looks: a status bar teaching "the app is at 127.0.0.1:32774" would
 *  be teaching a habit that breaks the moment this is deployed, so it is the
 *  absence of the data that removes it, at the same instant the habit stops
 *  working.
 */
export const PortsStatus = ({ projectId }: { projectId: string }) => {
  const { data } = useQuery({
    queryKey: ["projectPorts", projectId],
    queryFn: () => getProjectPorts(projectId),
    // Shared with the preview toolbar, which asks for the same thing. The
    // mapping is fixed for the life of a container, and a container that is
    // recreated remounts the editor.
    staleTime: Infinity,
  });

  const [copied, setCopied] = useState<number | null>(null);

  /** Every offered port that has somewhere to be reached, dev port first —
   *  which is the one somebody is nearly always after. */
  const published = (data?.ports ?? [])
    .map((port) => ({ port, address: data?.hostPorts?.[port] }))
    .filter(
      (entry): entry is { port: number; address: string } =>
        entry.address !== undefined,
    );

  if (published.length === 0) return null;

  const primary =
    published.find((entry) => entry.port === data?.devPort) ?? published[0]!;

  /** Copies, and says so for a moment.
   *
   *  `navigator.clipboard` needs a secure context, which plain-HTTP localhost
   *  is and a LAN address is not — so this can genuinely fail, and a control
   *  that silently did nothing would be worse than one that stays as it was.
   *  The address is on screen either way and can be read off it.
   */
  const copy = async (entry: { port: number; address: string }) => {
    try {
      await navigator.clipboard.writeText(`http://${entry.address}`);
      setCopied(entry.port);
      setTimeout(() => {
        setCopied(null);
      }, 1200);
    } catch {
      // No clipboard here.
    }
  };

  return (
    <Tooltip
      placement="top"
      title={
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ opacity: 0.75 }}>
            Published on this machine, for curl and Postman. The preview needs
            none of this and is the same URL in production.
          </div>
          {published.map((entry) => (
            <button
              key={entry.port}
              type="button"
              onClick={() => void copy(entry)}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                background: "none",
                border: "none",
                padding: 0,
                color: "inherit",
                font: "inherit",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ opacity: 0.75, minWidth: 42 }}>:{entry.port}</span>
              <span>
                {copied === entry.port ? "copied" : `http://${entry.address}`}
              </span>
            </button>
          ))}
          <div style={{ opacity: 0.6 }}>
            These change whenever the container is recreated.
          </div>
        </div>
      }
    >
      <button
        type="button"
        className="rc-statusbar-ports"
        aria-label={`Port ${String(primary.port)} is published at ${primary.address}`}
        onClick={() => void copy(primary)}
      >
        <VscRadioTower aria-hidden />
        {copied === primary.port ? "copied" : primary.address}
        {published.length > 1 && (
          <span style={{ opacity: 0.6 }}>+{published.length - 1}</span>
        )}
      </button>
    </Tooltip>
  );
};
