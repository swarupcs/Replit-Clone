import { useEffect, useState } from "react";
import { Input, Modal } from "antd";

interface NewEntryPromptProps {
  /** null closes the dialog. */
  kind: "file" | "folder" | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

/** Name prompt for creating an entry at the project root.
 *
 *  The context menu has its own copy of this flow because it also handles
 *  renames and nested parents; this one exists for the explorer toolbar, where
 *  there is no node under the cursor to derive a parent from.
 */
export const NewEntryPrompt = ({
  kind,
  onCancel,
  onConfirm,
}: NewEntryPromptProps) => {
  const [name, setName] = useState("");

  // Clear between openings so a cancelled name does not reappear.
  useEffect(() => {
    if (kind) setName("");
  }, [kind]);

  function confirm() {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  }

  return (
    <Modal
      open={kind !== null}
      title={kind === "folder" ? "New folder" : "New file"}
      okText="Create"
      onOk={confirm}
      onCancel={onCancel}
      okButtonProps={{ disabled: !name.trim() }}
      destroyOnHidden
    >
      <Input
        autoFocus
        value={name}
        placeholder={kind === "folder" ? "components" : "index.js"}
        onChange={(event) => setName(event.target.value)}
        onPressEnter={confirm}
      />
    </Modal>
  );
};
