import { useEffect, useState } from "react";
import { Alert, Button, Modal, Typography } from "antd";
import {
  clearRecovered,
  forgetBuffer,
  recoveredBuffers,
  type RecoveredBuffer,
} from "../../../lib/recoveredWork.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

/** Offers back edits that were typed and never confirmed saved. plan.md §11.7.
 *
 *  **The whole design is in what this does not do.** It does not write
 *  anything to disk. Replaying a local buffer over a file that somebody else
 *  has since edited — or that the user reloaded specifically to abandon —
 *  would be a worse failure than the one being fixed, and it is what "restore
 *  my work" quietly means if nobody decides otherwise. So the buffer is put
 *  back into the TAB, marked unsaved, and the person who typed it decides.
 *
 *  Shown once per project per load, and only when there is something to show.
 */
interface RecoveredWorkNoticeProps {
  projectId: string | undefined;
}

function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "less than a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? "" : "s"} ago`;
}

export function RecoveredWorkNotice({ projectId }: RecoveredWorkNoticeProps) {
  const [buffers, setBuffers] = useState<RecoveredBuffer[]>([]);
  const [reviewing, setReviewing] = useState(false);

  // Read once, on the way in. Re-reading as the record changes would make the
  // notice reappear while somebody is typing, which is exactly the moment it
  // has nothing useful to say.
  useEffect(() => {
    if (!projectId) return;
    setBuffers(recoveredBuffers(projectId));
  }, [projectId]);

  if (!projectId || buffers.length === 0) return null;

  function restore(): void {
    const tabs = useOpenTabsStore.getState();

    for (const buffer of buffers) {
      // Opened with the recovered content and marked unsaved, so the ordinary
      // save path is what puts it on disk — the one the user can see and
      // choose. Nothing here emits a write.
      tabs.openTab(buffer.relPath, buffer.data);
      tabs.markDirty(buffer.relPath, true);
    }

    setBuffers([]);
    setReviewing(false);
  }

  function discard(): void {
    if (projectId) clearRecovered(projectId);
    setBuffers([]);
    setReviewing(false);
  }

  function dismissOne(relPath: string): void {
    if (projectId) forgetBuffer(projectId, relPath);
    setBuffers((current) => current.filter((entry) => entry.relPath !== relPath));
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        banner
        role="status"
        style={{ borderRadius: 0 }}
        message={
          buffers.length === 1
            ? `Unsaved changes to ${buffers[0]?.relPath ?? ""} were kept from ${ago(buffers[0]?.savedAt ?? Date.now())}.`
            : `Unsaved changes to ${String(buffers.length)} files were kept from before.`
        }
        action={
          <>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setReviewing(true);
              }}
            >
              Review
            </Button>
            <Button size="small" type="text" onClick={discard}>
              Discard
            </Button>
          </>
        }
      />

      <Modal
        open={reviewing}
        title="Unsaved changes from before"
        okText="Reopen them"
        cancelText="Discard them"
        onOk={restore}
        onCancel={discard}
        // Closing with the X is neither answer, so it leaves the record alone
        // and the banner in place. Only the two buttons decide.
        afterClose={() => {
          setReviewing(false);
        }}
      >
        <Typography.Paragraph style={{ fontSize: 13 }}>
          These were typed but never confirmed saved — a lost connection, a
          closed tab, or a reload. Reopening puts them back in the editor as
          unsaved changes; <b>nothing is written to disk until you save</b>, so
          you can compare them against what is there now.
        </Typography.Paragraph>

        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {buffers.map((buffer) => (
            <li key={buffer.relPath} style={{ marginBottom: 6 }}>
              <code>{buffer.relPath}</code>{" "}
              <span style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}>
                {ago(buffer.savedAt)}
              </span>{" "}
              <Button
                size="small"
                type="link"
                onClick={() => {
                  dismissOne(buffer.relPath);
                }}
              >
                forget this one
              </Button>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
