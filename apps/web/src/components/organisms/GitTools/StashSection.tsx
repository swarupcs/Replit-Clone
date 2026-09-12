import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Input, Popconfirm, Typography, message } from "antd";
import type { GitStash } from "@replit-clone/shared";
import {
  applyStashApi,
  dropStashApi,
  getStashesApi,
  pushStashApi,
} from "../../../apis/projects.ts";

/** Stash. plan.md §10.13, and §10 says it is one of the two a personal user
 *  notices in the first week.
 *
 *  Inside the source control panel rather than in a dialog, because a stash is
 *  part of the same loop as staging and committing: it is what somebody reaches
 *  for *instead of* committing, and putting it behind a menu would make the
 *  cheaper option the harder one to find.
 *
 *  **Apply and pop are one button and a choice, not two buttons.** The
 *  difference is whether the stash survives, which is a question about what
 *  happens next rather than about what to click — so the primary action keeps
 *  it and dropping is deliberate. A stash you meant to keep and popped is
 *  recoverable only through the reflog, which nobody reaches for in time.
 */
export function StashSection({
  projectId,
  canEdit,
  onChanged,
}: {
  projectId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  /** Plain state rather than react-query, to match the panel this sits inside.
   *
   *  Not a style preference: `SourceControlPanel` is rendered without a
   *  `QueryClientProvider` above it, so a `useQuery` here throws "No
   *  QueryClient set" and takes the whole panel down. Its own tests caught
   *  that, and the fix that keeps the panel independent of a provider it never
   *  needed is to read the way the panel already reads.
   */
  const load = useCallback(async () => {
    try {
      setStashes(await getStashesApi(projectId));
    } catch {
      // A project with no repository, or a server that is down. Neither is
      // worth a message: the rest of the panel already says so.
      setStashes([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One wrapper, so every action reports the same way and none of them can
   *  forget to refresh. */
  const run = async (work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await work();
      void message.success(done);
      await load();
      onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "git failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography.Text strong style={{ fontSize: 12.5 }}>
          Stashes
        </Typography.Text>
        {canEdit && (
          <Button
            size="small"
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            Stash changes
          </Button>
        )}
      </div>

      {open && (
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            size="small"
            aria-label="Stash message"
            placeholder="What is this for?"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <Button
            size="small"
            type="primary"
            loading={busy}
            onClick={() => {
              void run(async () => {
                // Untracked files included: a stash that silently leaves new
                // files behind is one that loses them at the next checkout.
                await pushStashApi(projectId, draft, true);
                setDraft("");
                setOpen(false);
              }, "Stashed");
            }}
          >
            Stash
          </Button>
        </div>
      )}

      {stashes.length === 0 ? (
        <Empty
          image={null}
          description={
            <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
              Nothing stashed.
            </span>
          }
          style={{ margin: 0 }}
        />
      ) : (
        stashes.map((stash) => (
          <div
            key={stash.ref}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              borderTop: "1px solid var(--rc-border)",
              paddingTop: 6,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {stash.message}
              </div>
              {/* The branch, because it is most of how somebody tells two
                  stashes apart. */}
              <div style={{ color: "var(--rc-text-subtle)", fontSize: 11.5 }}>
                on {stash.branch || "an unknown branch"}
              </div>
            </div>
            {canEdit && (
              <>
                <Button
                  size="small"
                  loading={busy}
                  onClick={() => {
                    void run(
                      () => applyStashApi(projectId, stash.index, false),
                      "Applied",
                    );
                  }}
                >
                  Apply
                </Button>
                {/* Popping DESTROYS it, so it is the confirmed action rather
                    than the convenient one. */}
                <Popconfirm
                  title="Apply and delete this stash?"
                  okText="Pop"
                  onConfirm={() => {
                    void run(
                      () => applyStashApi(projectId, stash.index, true),
                      "Applied",
                    );
                  }}
                >
                  <Button size="small">Pop</Button>
                </Popconfirm>
                <Popconfirm
                  title="Delete this stash without applying it?"
                  okText="Delete"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    void run(() => dropStashApi(projectId, stash.index), "Dropped");
                  }}
                >
                  <Button size="small" danger aria-label={`Delete ${stash.message}`}>
                    ✕
                  </Button>
                </Popconfirm>
              </>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export default StashSection;
