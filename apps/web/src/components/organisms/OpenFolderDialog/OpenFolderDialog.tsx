import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Breadcrumb, Button, Empty, Modal, Spin, Typography } from "antd";
import { VscFolder, VscFolderOpened, VscRootFolder } from "react-icons/vsc";
import type { Project } from "@replit-clone/shared";
import {
  browseLocalFoldersApi,
  getLocalFolderSettingsApi,
  openLocalFolderApi,
} from "../../../apis/projects.ts";

interface OpenFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onOpened: (project: Project) => void;
}

/** Opening a folder that is already on the disk.
 *
 *  A picker rather than a path field, and the reason is not polish: a field
 *  alone means you have to already know the path you want and every typo is a
 *  refusal from an allowlist you cannot see. Walking makes the allowed roots
 *  the starting point, so what may be opened is visible rather than guessed at.
 *
 *  It walks the SERVER's disk, not the browser's, which is worth being explicit
 *  about in the UI: the folder is mounted into a container on the machine
 *  running this deployment, so on a remote deployment these are that host's
 *  directories and not the ones on the laptop looking at the page.
 */

function reasonFrom(error: unknown, fallback: string): string {
  const body = (error as { response?: { data?: { message?: unknown } } }).response
    ?.data;
  if (typeof body?.message === "string" && body.message) return body.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The trail back to the root this walk started from.
 *
 *  Derived from the two paths rather than accumulated as state, so it cannot
 *  drift from where the browse actually is -- the same argument the keybinding
 *  registry makes about a chord and its display string.
 */
export function trailFor(root: string, current: string): string[] {
  if (!current.startsWith(root)) return [root];

  const rest = current.slice(root.length).split("/").filter(Boolean);

  const trail = [root];
  let walked = root;
  for (const segment of rest) {
    walked = `${walked}/${segment}`;
    trail.push(walked);
  }
  return trail;
}

/** The last segment of a path, for a breadcrumb that is not all one long
 *  string. The root keeps its full path, because "home" is not a location. */
export function labelFor(path: string, root: string): string {
  if (path === root) return root;
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export const OpenFolderDialog = ({
  open,
  onClose,
  onOpened,
}: OpenFolderDialogProps) => {
  const queryClient = useQueryClient();

  /** Which configured root this walk started from, and where it is now. Null
   *  until the settings arrive, since there may be no roots at all. */
  const [root, setRoot] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ["projects", "local", "settings"],
    queryFn: getLocalFolderSettingsApi,
    enabled: open,
  });

  const roots = settings.data?.roots ?? [];
  const enabled = settings.data?.enabled ?? false;

  // One root is the ordinary configuration, and making somebody choose from a
  // list of one is a click that says nothing.
  useEffect(() => {
    if (!open || root !== null || roots.length !== 1) return;
    setRoot(roots[0] ?? null);
    setCurrent(roots[0] ?? null);
  }, [open, root, roots]);

  // So reopening the dialog does not resume somebody else's walk.
  useEffect(() => {
    if (open) return;
    setRoot(null);
    setCurrent(null);
    setError(null);
  }, [open]);

  const entries = useQuery({
    queryKey: ["projects", "local", "browse", current],
    queryFn: () => browseLocalFoldersApi(current ?? ""),
    enabled: open && enabled && current !== null,
  });

  const openFolder = useMutation({
    mutationFn: (path: string) => openLocalFolderApi(path),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpened(project);
    },
    onError: (failure: unknown) => {
      setError(reasonFrom(failure, "Could not open that folder."));
    },
  });

  function go(path: string): void {
    setError(null);
    setCurrent(path);
  }

  const trail = root && current ? trailFor(root, current) : [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={620}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <VscFolderOpened size={17} />
          Open a folder
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!current}
            loading={openFolder.isPending}
            onClick={() => current && openFolder.mutate(current)}
          >
            Open this folder
          </Button>
        </>
      }
      destroyOnHidden
    >
      {settings.isLoading ? (
        <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
          <Spin />
        </div>
      ) : !enabled ? (
        <Alert
          type="info"
          showIcon
          message="Opening folders is not configured"
          description={
            <>
              This deployment has not named any directories that may be opened.
              Set <code>LOCAL_FOLDER_ROOTS</code> on the server to the folders it
              may reach — it is empty by default, and should stay empty on any
              deployment with more than one account on it.
            </>
          }
        />
      ) : (
        <>
          {error && (
            <Alert
              type="error"
              showIcon
              closable
              message={error}
              onClose={() => setError(null)}
              style={{ marginBottom: 12 }}
            />
          )}

          {root === null ? (
            <>
              <Typography.Paragraph style={{ fontSize: 13 }}>
                Start from one of the folders this deployment allows:
              </Typography.Paragraph>
              {roots.map((entry) => (
                <div
                  key={entry}
                  className="rc-tree-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setRoot(entry);
                    go(entry);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setRoot(entry);
                    go(entry);
                  }}
                >
                  <VscRootFolder size={13} style={{ flex: "none" }} />
                  <span style={{ fontSize: 13 }}>{entry}</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <Breadcrumb
                style={{ marginBottom: 10, fontSize: 12.5 }}
                items={trail.map((path) => ({
                  title:
                    path === current ? (
                      <span>{labelFor(path, root)}</span>
                    ) : (
                      <a
                        onClick={(event) => {
                          event.preventDefault();
                          go(path);
                        }}
                        href="#"
                      >
                        {labelFor(path, root)}
                      </a>
                    ),
                }))}
              />

              <div style={{ maxHeight: 340, overflowY: "auto" }}>
                {entries.isLoading ? (
                  <div
                    style={{ display: "grid", placeItems: "center", padding: 32 }}
                  >
                    <Spin />
                  </div>
                ) : entries.data?.length ? (
                  entries.data.map((entry) => (
                    <div
                      key={entry.path}
                      className="rc-tree-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => go(entry.path)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        go(entry.path);
                      }}
                    >
                      <VscFolder size={13} style={{ flex: "none" }} />
                      <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                        {entry.name}
                      </span>
                    </div>
                  ))
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No folders in here"
                  />
                )}
              </div>
            </>
          )}

          <Typography.Paragraph
            style={{
              marginTop: 12,
              marginBottom: 0,
              fontSize: 12,
              color: "var(--rc-text-subtle)",
            }}
          >
            These are folders on the machine running this server, not on this
            computer. Nothing is copied: the folder is edited in place, and
            deleting the project later closes it and leaves the files alone.
          </Typography.Paragraph>
        </>
      )}
    </Modal>
  );
};
