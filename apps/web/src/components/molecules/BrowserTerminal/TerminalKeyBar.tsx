import { useState } from "react";
import { TOUCH_KEYS, pressTouchKey } from "../../../lib/touchKeys.ts";

/** The keys a software keyboard does not have. plan.md §13.10.
 *
 *  Shown only for a coarse pointer, and that is a capability question rather
 *  than a width one: a narrow desktop window has a real `Ctrl` and does not
 *  want a row of fake ones in front of its terminal.
 */
export function TerminalKeyBar({ onSend }: { onSend: (data: string) => void }) {
  /** Ctrl is the only stateful key here, and it is one-shot: it applies to the
   *  next key and lets go. Held in the component rather than in a store
   *  because it belongs to this terminal and dies with it. */
  const [ctrlArmed, setCtrlArmed] = useState(false);

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      style={{
        display: "flex",
        gap: 6,
        padding: "6px 8px",
        overflowX: "auto",
        borderTop: "1px solid var(--rc-border)",
        // The bar must not grow: it sits under a terminal that needs the rest.
        flex: "0 0 auto",
      }}
    >
      {TOUCH_KEYS.map((key) => {
        const armed = key.sticky && ctrlArmed;

        return (
          <button
            key={key.id}
            type="button"
            title={key.title}
            aria-label={key.title}
            aria-pressed={key.sticky ? ctrlArmed : undefined}
            onClick={() => {
              const result = pressTouchKey(key, ctrlArmed);
              setCtrlArmed(result.ctrlArmed);
              if (result.send !== null) onSend(result.send);
            }}
            style={{
              // 44px: a fingertip covers about 9mm and lands approximately.
              minWidth: 44,
              minHeight: 36,
              flex: "0 0 auto",
              borderRadius: 6,
              border: "1px solid var(--rc-border)",
              background: armed ? "var(--rc-accent, #1677ff)" : "transparent",
              color: armed ? "#fff" : "inherit",
              fontFamily: "monospace",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}

export default TerminalKeyBar;
