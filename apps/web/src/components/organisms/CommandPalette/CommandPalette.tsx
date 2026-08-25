import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Input } from "antd";
import type { InputRef } from "antd";
import { filterCommands } from "../../../lib/commands.ts";
import type { Command } from "../../../lib/commands.ts";

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

/** Ctrl/Cmd+Shift+P command palette.
 *
 *  Deliberately the same shape as QuickOpen -- a modal sitting high, one input,
 *  an arrow-navigable list -- because they are the same gesture aimed at
 *  different things, and a palette that behaved differently would be a second
 *  thing to learn. What it lists is commands rather than files, so the ranking
 *  and the disabled handling live in `lib/commands.ts` instead.
 */
export const CommandPalette = ({ open, onClose, commands }: Props) => {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  // Reset per opening, so it never reopens showing a stale query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlighted(0);
    }
  }, [open]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(highlighted)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  function run(command: Command | undefined) {
    if (!command) return;
    // A disabled entry is shown so the palette can explain itself, but it must
    // not fire.
    if (command.enabled === false) return;

    // Closed BEFORE running: a command that opens another dialog would
    // otherwise be closed again by this one's own teardown.
    onClose();
    command.run();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[highlighted]);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      destroyOnHidden
      width={560}
      style={{ top: 90 }}
      styles={{ body: { padding: 0 } }}
      afterOpenChange={(isOpen) => {
        if (isOpen) inputRef.current?.focus();
      }}
    >
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        placeholder="Run a command…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        style={{ fontSize: 15, padding: "12px 16px" }}
      />

      <div
        ref={listRef}
        style={{
          maxHeight: 340,
          overflowY: "auto",
          borderTop: "1px solid var(--rc-border)",
          padding: 6,
        }}
      >
        {results.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--rc-text-subtle)",
            }}
          >
            No matching commands
          </div>
        ) : (
          results.map((command, index) => {
            const disabled = command.enabled === false;

            return (
              <div
                key={command.id}
                data-index={index}
                data-command={command.id}
                className="rc-quickopen-row"
                data-highlighted={index === highlighted}
                aria-disabled={disabled}
                style={{ opacity: disabled ? 0.45 : 1 }}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => run(command)}
              >
                <span
                  style={{
                    color: "var(--rc-text-subtle)",
                    fontSize: 11.5,
                    flex: "none",
                  }}
                >
                  {command.category}
                </span>
                <span style={{ fontWeight: 500, flex: 1 }}>{command.title}</span>
                {(disabled ? command.disabledReason : command.keys) && (
                  <span
                    style={{
                      color: "var(--rc-text-subtle)",
                      fontSize: 11,
                      fontFamily: disabled
                        ? undefined
                        : "ui-monospace, SFMono-Regular, Menlo, monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {disabled ? command.disabledReason : command.keys}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
};
