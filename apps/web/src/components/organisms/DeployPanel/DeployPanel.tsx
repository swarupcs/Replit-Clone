import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Spin, Tooltip, message } from "antd";
import { CustomDomain } from "../../molecules/CustomDomain/CustomDomain.tsx";
import { ReleaseHistory } from "../../molecules/ReleaseHistory/ReleaseHistory.tsx";
import {
  VscCloudUpload,
  VscCopy,
  VscLinkExternal,
  VscRefresh,
  VscTrash,
} from "react-icons/vsc";
import type { DeploymentState } from "@replit-clone/shared";
import {
  deployApi,
  getDeploymentApi,
  undeployApi,
} from "../../../apis/deployments.ts";

interface DeployPanelProps {
  projectId: string;
  /** Publishing puts a project in front of the entire internet, so it is the
   *  owner's decision alone — not an editor's. Everyone who can open the
   *  project can still SEE whether it is live and where. */
  isOwner: boolean;
}

/** How long ago, in the coarsest unit that is still true. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86400))}d ago`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Publishing a project to a public address.
 *
 *  The preview shows a dev server to somebody who already has a session, behind
 *  a container that stops when it goes idle. This is the other thing: an origin
 *  that needs no account, that stays up. It is the difference between an editor
 *  and somewhere you finish something.
 *
 *  Two shapes, and the panel says which one this project gets rather than
 *  hiding it. They differ in the ways a user would notice: a static site keeps
 *  nothing running and cannot fall over, while a service holds memory for as
 *  long as it is published and can crash on its own — so the copy, the log and
 *  the "take offline" tooltip are all worded per kind.
 */
export const DeployPanel = ({ projectId, isOwner }: DeployPanelProps) => {
  const [state, setState] = useState<DeploymentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await getDeploymentApi(projectId));
    } catch {
      // Nothing useful to say that the empty state below does not say better.
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function deploy() {
    setBusy(true);
    try {
      const deployment = await deployApi(projectId);
      setState((previous) => (previous ? { ...previous, deployment } : previous));
      void message.success("Deployed");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The deploy failed";
      void message.error(reason);
      // The row records the failure and its log, so re-reading is what puts
      // the build's own output on screen rather than only a toast.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function takeOffline() {
    setBusy(true);
    try {
      setState(await undeployApi(projectId));
      void message.success("Taken offline");
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "Could not take it offline",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      void message.success("Link copied");
    } catch {
      void message.error("Could not copy the link");
    }
  }

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <Spin />
      </div>
    );
  }

  if (!state?.target.deployable) {
    return (
      <div style={{ padding: "24px 16px" }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}>
              {state?.target.reason ??
                "This project cannot be published."}
            </span>
          }
        />
      </div>
    );
  }

  const { deployment, target } = state;
  const live = deployment?.status === "live" && deployment.url !== null;
  // The kind that WOULD be used, unless something is already published — in
  // which case what is actually running is the honest thing to describe.
  const kind = deployment?.kind ?? target.kind;
  const isService = kind === "service";

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
        <VscCloudUpload size={13} />
        <span style={{ flex: 1 }}>Deploy</span>
        <Tooltip title="Check again">
          <button
            className="rc-icon-button"
            aria-label="Refresh deployment"
            onClick={() => void refresh()}
          >
            <VscRefresh size={13} />
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 10px" }}>
        {live && deployment.url && (
          <div className="rc-deploy-live">
            <div className="rc-deploy-dot" aria-hidden />
            <a
              className="rc-deploy-url"
              href={deployment.url}
              target="_blank"
              // A published site is untrusted code on an origin of its own, and
              // this link opens it. Without `noopener` the new tab keeps a
              // handle on the editor's window and can navigate it away.
              rel="noopener noreferrer"
              title={deployment.url}
            >
              {deployment.url.replace(/^https?:\/\//, "")}
            </a>
            <Tooltip title="Copy link">
              <button
                className="rc-icon-button"
                aria-label="Copy deployment link"
                onClick={() => void copyUrl(deployment.url ?? "")}
              >
                <VscCopy size={12} />
              </button>
            </Tooltip>
            <Tooltip title="Open">
              <a
                className="rc-icon-button"
                aria-label="Open the deployed site"
                href={deployment.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <VscLinkExternal size={12} />
              </a>
            </Tooltip>
          </div>
        )}

        {live && deployment.deployedAt && (
          <div className="rc-deploy-meta">
            Published {ago(deployment.deployedAt)} · {size(deployment.sizeBytes)}
            {isService && " · always on"}
          </div>
        )}

        {!live && (
          <p className="rc-deploy-blurb">
            {deployment
              ? "This project is not live right now."
              : isService
                ? "This project answers requests from a running process, so " +
                  "publishing it keeps a container of its own running at a " +
                  "public address. Anyone with the link can open it — no " +
                  "account — and it stays up when you close the editor."
                : "Build this project and publish it at a public address. " +
                  "Anyone with the link can open it — no account, and nothing " +
                  "left running."}
          </p>
        )}

        {deployment?.error && (
          <div className="rc-deploy-error" role="alert">
            {deployment.error}
          </div>
        )}

        <div className="rc-deploy-command">
          <span>{target.buildCommand || "No build step"}</span>
          <span className="rc-deploy-outdir">
            {isService && target.port !== null
              ? `→ :${String(target.port)}`
              : `→ ${target.outputDir}`}
          </span>
        </div>

        {isOwner && (
          <div style={{ display: "flex", gap: 6, paddingBottom: 10 }}>
            <Button
              size="small"
              type="primary"
              loading={busy}
              icon={<VscCloudUpload size={12} />}
              onClick={() => void deploy()}
            >
              {live ? "Redeploy" : "Deploy"}
            </Button>
            {deployment && (
              <Tooltip
                title={
                  isService
                    ? "Stop the container and free the address"
                    : "Remove the published files and free the address"
                }
              >
                <Button
                  size="small"
                  danger
                  disabled={busy}
                  aria-label="Take offline"
                  icon={<VscTrash size={12} />}
                  onClick={() => void takeOffline()}
                />
              </Tooltip>
            )}
          </div>
        )}

        {/* Only once something is published. A domain pointed at a project
            with no deployment behind it is a name that resolves to a 404,
            and the server refuses the claim for that reason — so offering
            the form first would be offering a button that cannot work. */}
        {isOwner && deployment && (
          <CustomDomain
            projectId={projectId}
            domain={deployment.customDomain}
            onChange={refresh}
          />
        )}

        {/* Reading the history is a viewer's -- it is the record of a thing
            that is public by construction. Rolling back is the owner's, and
            the component draws that line itself. */}
        {deployment && (
          <ReleaseHistory
            projectId={projectId}
            isOwner={isOwner}
            refreshKey={deployment.deployedAt ? 1 : 0}
          />
        )}

        {!isOwner && (
          <p className="rc-deploy-blurb">
            Only the project&apos;s owner can publish it.
          </p>
        )}

        {deployment?.log && (
          <pre
            className="rc-deploy-log"
            aria-label={isService ? "App output" : "Build output"}
          >
            {deployment.log}
          </pre>
        )}
      </div>
    </div>
  );
};
