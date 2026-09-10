import { useState } from "react";
import { Alert, Input, Modal, Segmented, Typography, message } from "antd";
import { getGitBranchesApi, showFileAtRefApi } from "../../../apis/projects.ts";
import { readFileForCompare } from "../../../lib/compareSources.ts";
import { useCompareStore } from "../../../store/compareStore.ts";

/** Choosing what the diff pane compares against. plan.md §10.11.
 *
 *  The row's complaint was that the editor could only diff a buffer against its
 *  own saved copy — "the thing you reach for at commit time and not the thing
 *  you reach for daily". Three sources: the saved file, a branch or commit, or
 *  another file in the project.
 *
 *  Fetching happens here rather than in the editor, so the editor renders
 *  whatever it is given and this screen owns the one thing that can fail.
 */
type Source = "saved" | "ref" | "file";

export function CompareDialog({
  projectId,
  open,
  onClose,
  relPath,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  relPath: string | null;
}) {
  const [source, setSource] = useState<Source>("saved");
  const [ref, setRef] = useState("");
  const [otherPath, setOtherPath] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const { setAgainst, setLeft, setLoading } = useCompareStore();

  // Loaded when the dialog opens rather than on every render, and failure is
  // silent: the branch list is a convenience over a text field that works
  // without it.
  const loadBranches = (): void => {
    void getGitBranchesApi(projectId)
      .then((list) => {
        setBranches(list.map((branch) => branch.name));
      })
      .catch(() => {
        setBranches([]);
      });
  };

  const apply = async (): Promise<void> => {
    if (!relPath) return;
    setBusy(true);
    setLoading(true);

    try {
      if (source === "saved") {
        setAgainst({ kind: "saved" });
        // Nothing to fetch: the editor already holds the saved copy, which is
        // exactly why this is the default.
        setLeft(null, false);
      } else if (source === "ref") {
        setAgainst({ kind: "ref", ref: ref.trim() });
        const result = await showFileAtRefApi(projectId, ref.trim(), relPath);
        setLeft(result.contents, !result.exists);
      } else {
        setAgainst({ kind: "file", relPath: otherPath.trim() });
        setLeft(await readFileForCompare(projectId, otherPath.trim()), false);
      }
      onClose();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "Could not read that");
      setLeft(null, false);
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Compare with"
      open={open}
      onCancel={onClose}
      afterOpenChange={(isOpen) => {
        if (isOpen) loadBranches();
      }}
      okText="Compare"
      confirmLoading={busy}
      okButtonProps={{
        disabled:
          !relPath ||
          (source === "ref" && ref.trim() === "") ||
          (source === "file" && otherPath.trim() === ""),
      }}
      onOk={() => {
        void apply();
      }}
      destroyOnHidden
    >
      {!relPath ? (
        <Alert type="info" message="Open a file first." />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <Segmented<Source>
            options={[
              { label: "Saved copy", value: "saved" },
              { label: "A branch or commit", value: "ref" },
              { label: "Another file", value: "file" },
            ]}
            value={source}
            onChange={setSource}
          />

          {source === "ref" && (
            <>
              <Input
                aria-label="Branch, tag or commit"
                placeholder="main"
                list="rc-compare-branches"
                value={ref}
                onChange={(event) => {
                  setRef(event.target.value);
                }}
              />
              <datalist id="rc-compare-branches">
                {branches.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          )}

          {source === "file" && (
            <Input
              aria-label="Other file"
              placeholder="src/other.ts"
              value={otherPath}
              onChange={(event) => {
                setOtherPath(event.target.value);
              }}
              style={{ fontFamily: "monospace" }}
            />
          )}

          <Typography.Paragraph
            style={{ color: "var(--rc-text-subtle)", fontSize: 12, marginBottom: 0 }}
          >
            The right-hand side is always this buffer, and you can type in it —
            edits save the way they always do.
          </Typography.Paragraph>
        </div>
      )}
    </Modal>
  );
}

export default CompareDialog;
