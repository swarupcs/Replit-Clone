import { useEffect } from "react";

export interface Hotkey {
  /** Lowercase `event.key`, or the literal for punctuation (e.g. "`"). */
  key: string;
  /** Ctrl on Windows/Linux, Cmd on macOS — matched against whichever the
   *  platform actually uses, so one definition covers both. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: () => void;
}

/** True when the event came from somewhere that owns its own keystrokes.
 *
 *  Without this, Ctrl+B inside the filter box or a rename dialog would toggle
 *  the sidebar instead of reaching the input. Monaco is excluded too — it has
 *  its own keybinding layer and registers Ctrl+S itself.
 */
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target.isContentEditable) return true;
  if (target.closest(".monaco-editor")) return true;
  // xterm renders a hidden textarea that receives all terminal input.
  if (target.closest(".xterm")) return true;

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Global keyboard shortcuts.
 *
 *  Bound on `document` in the capture phase so a shortcut still fires when
 *  focus is inside a pane that stops propagation.
 */
export function useHotkeys(hotkeys: Hotkey[], enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      for (const hotkey of hotkeys) {
        if (key !== hotkey.key.toLowerCase()) continue;
        if (Boolean(hotkey.mod) !== mod) continue;
        if (Boolean(hotkey.shift) !== event.shiftKey) continue;
        if (Boolean(hotkey.alt) !== event.altKey) continue;

        // A bare (unmodified) shortcut must never steal an ordinary keystroke.
        if (!hotkey.mod && !hotkey.alt && isTypingContext(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        hotkey.handler();
        return;
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [hotkeys, enabled]);
}
