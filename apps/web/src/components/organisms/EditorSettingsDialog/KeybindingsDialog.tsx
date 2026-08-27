import { useMemo, useState } from "react";
import { Button, Modal, Tag, Typography } from "antd";
import {
  DEFAULT_KEYBINDINGS,
  chordKey,
  formatChord,
  resolveBindings,
  type Chord,
} from "../../../lib/keybindings.ts";
import {
  selectOverrides,
  useKeybindingStore,
} from "../../../store/keybindingStore.ts";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Reads the next chord the user presses.
 *
 *  Modifiers alone are ignored: somebody on their way to Ctrl+Shift+K holds
 *  Ctrl first, and capturing that as "the chord is Ctrl" would make the
 *  control impossible to use. */
function chordFromEvent(event: React.KeyboardEvent): Chord | null {
  const key = event.key;
  if (["Control", "Meta", "Shift", "Alt"].includes(key)) return null;

  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    mod: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** Which command a chord already belongs to, if any. */
function heldBy(
  bindings: Record<string, Chord>,
  chord: Chord,
  except: string,
): string | undefined {
  const wanted = chordKey(chord);
  return Object.entries(bindings).find(
    ([commandId, existing]) => commandId !== except && chordKey(existing) === wanted,
  )?.[0];
}

/** Rebinding, as a list of commands with the chord each currently has.
 *
 *  Deliberately plain: a chord recorder and a conflict warning are the whole
 *  feature. Anything more — chord sequences, per-context bindings — is what
 *  VS Code's keybindings.json is for, and this is not that.
 */
export const KeybindingsDialog = ({ open, onClose }: Props) => {
  const overrides = useKeybindingStore(selectOverrides);
  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
  const bind = useKeybindingStore((state) => state.bind);
  const reset = useKeybindingStore((state) => state.reset);
  const resetAll = useKeybindingStore((state) => state.resetAll);

  const [recording, setRecording] = useState<string | null>(null);
  const [clash, setClash] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      title="Keyboard shortcuts"
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Button onClick={resetAll} disabled={Object.keys(overrides).length === 0}>
            Reset all
          </Button>
          <Button type="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
      destroyOnHidden
    >
      <Typography.Paragraph style={{ color: "var(--rc-text-subtle)", fontSize: 13 }}>
        Click a shortcut, then press the keys you want.
      </Typography.Paragraph>

      <div style={{ maxHeight: 360, overflow: "auto" }}>
        {Object.keys(DEFAULT_KEYBINDINGS).map((commandId) => {
          const chord = bindings[commandId];
          if (!chord) return null;

          const isRecording = recording === commandId;

          return (
            <div
              key={commandId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "6px 0",
                borderBottom: "1px solid var(--rc-border)",
              }}
            >
              <span style={{ fontSize: 13 }}>{commandId}</span>

              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {overrides[commandId] && (
                  <button
                    type="button"
                    className="rc-icon-button"
                    aria-label={`Reset ${commandId}`}
                    onClick={() => reset(commandId)}
                  >
                    ↺
                  </button>
                )}

                <button
                  type="button"
                  aria-label={`Change the shortcut for ${commandId}`}
                  className="rc-chord-button"
                  data-recording={isRecording}
                  onClick={() => {
                    setRecording(commandId);
                    setClash(null);
                  }}
                  onBlur={() => setRecording(null)}
                  onKeyDown={(event) => {
                    if (!isRecording) return;
                    event.preventDefault();

                    if (event.key === "Escape") {
                      setRecording(null);
                      return;
                    }

                    const next = chordFromEvent(event);
                    if (!next) return;

                    const taken = heldBy(bindings, next, commandId);
                    if (taken) {
                      // Refused rather than silently stolen: taking a chord
                      // from another command would leave that one dead with
                      // no sign of why.
                      setClash(`${formatChord(next)} is already ${taken}`);
                      return;
                    }

                    bind(commandId, next);
                    setRecording(null);
                    setClash(null);
                  }}
                >
                  {isRecording ? "Press keys…" : formatChord(chord)}
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {clash && (
        <Tag color="warning" style={{ marginTop: 10 }}>
          {clash}
        </Tag>
      )}
    </Modal>
  );
};
