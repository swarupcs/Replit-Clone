import { useCallback, useEffect, useState } from "react";
import { Button, Popconfirm, Tooltip, message } from "antd";
import { VscHistory, VscDebugRestart } from "react-icons/vsc";
import type { DeploymentRelease } from "@replit-clone/shared";
import { listReleasesApi, rollbackApi } from "../../../apis/deployments.ts";

/** What this project has published, and going back to one of them.
 *
 *  A publish used to overwrite its own predecessor, so "put back the one that
 *  worked" had nothing to put back. Each build now keeps its own files and the
 *  deployment points at the live one, which is why rolling back is instant:
 *  nothing is rebuilt.
 *
 *  Worth saying in the UI, because it is the thing people get wrong about
 *  rollbacks — this puts back the bytes that were serving, not a fresh build
 *  of a tree that has moved on since.
 */
interface ReleaseHistoryProps {
  projectId: string;
  isOwner: boolean;
  /** Bumped by the panel after a deploy, so the list re-reads without this
   *  component having to know what a deploy is. */
  refreshKey?: number;
}

export const ReleaseHistory = ({
  projectId,
  isOwner,
  refreshKey = 0,
}: ReleaseHistoryProps) => {
  const [releases, setReleases] = useState<DeploymentRelease[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReleases(await listReleasesApi(projectId));
    } catch {
      // A project with no deployment has no history, and neither case is worth
      // a toast on a panel somebody opened to do something else.
      setReleases([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Nothing to show until there are at least two: a single build IS the live
  // one, and a history of one entry is a list that only takes up room.
  if (releases.length < 2) return null;

  const rollback = async (release: DeploymentRelease) => {
    setBusy(true);
    try {
      setReleases(await rollbackApi(projectId, release.id));
      message.success("Rolled back. That build is being served again.");
    } catch (error) {
      // The server's own words: "only a static site can be rolled back" and
      // "already being served" both tell somebody what to do next.
      message.error(
        error instanceof Error ? error.message : "Could not roll back",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rc-releases">
      <div className="rc-releases-head">
        <VscHistory size={12} />
        <span>Previous builds</span>
      </div>

      <div className="rc-releases-list">
        {releases.map((release) => (
          <div className="rc-release" key={release.id} data-live={release.live}>
            <div className="rc-release-when">
              <span>{when(release.createdAt)}</span>
              {release.live && <span className="rc-release-live">serving</span>}
            </div>

            <span className="rc-release-size">{size(release.sizeBytes)}</span>

            {isOwner && !release.live && (
              <Popconfirm
                title="Serve this build again?"
                // The reassurance that matters: it is not a rebuild, so
                // whatever is in the editor right now is irrelevant to it.
                description="Its files are still here, so nothing is rebuilt."
                okText="Roll back"
                onConfirm={() => void rollback(release)}
              >
                <Tooltip title="Serve this build again">
                  <Button
                    size="small"
                    type="text"
                    disabled={busy}
                    aria-label={`Roll back to the build from ${when(release.createdAt)}`}
                    icon={<VscDebugRestart size={12} />}
                  />
                </Tooltip>
              </Popconfirm>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  if (minutes < 60 * 24) return `${String(Math.round(minutes / 60))}h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
