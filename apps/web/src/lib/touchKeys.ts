/** The keys a touch keyboard does not have. plan.md §13.10.
 *
 *  §13.10's sharpest concrete complaint is "a terminal with no `Ctrl`". A
 *  software keyboard offers letters, digits and punctuation; it has no control
 *  key, no escape, usually no tab and no arrows. So `Ctrl+C` — the single most
 *  necessary keystroke in a terminal — cannot be typed at all, and a shell you
 *  cannot interrupt is a shell you cannot use.
 *
 *  **This file is a table of bytes, deliberately.** A terminal takes a stream,
 *  not key events: what `Ctrl+C` *is*, as far as the far end is concerned, is
 *  the byte 0x03. Writing it as a lookup keeps the whole of the mapping in one
 *  readable place and makes it exactly testable, with no DOM and no xterm.
 */

/** The control byte for a letter, per the ASCII control range.
 *
 *  `Ctrl+A` is 0x01 and the alphabet runs from there, which is just the letter
 *  with its top three bits cleared. Computed rather than tabulated so the
 *  relationship is visible and twenty-six rows cannot drift.
 */
export function controlByte(letter: string): string | null {
  if (letter.length !== 1) return null;

  const upper = letter.toUpperCase();
  const code = upper.codePointAt(0) ?? 0;

  // A..Z only. Ctrl of anything else is not a thing this offers, rather than
  // a thing it guesses at.
  if (code < 0x41 || code > 0x5a) return null;

  return String.fromCharCode(code - 0x40);
}

/** What one key on the bar sends. */
export interface TouchKey {
  id: string;
  /** What it says on the key. */
  label: string;
  /** The bytes to send, or null for a key that only sets the modifier. */
  send: string | null;
  /** True for `Ctrl`, which arms the next letter instead of sending anything
   *  itself — the only stateful key on the bar. */
  sticky?: boolean;
  /** A longer name for assistive technology, since the labels are glyphs. */
  title: string;
}

const ESC = String.fromCharCode(27);

/** The bar itself.
 *
 *  Chosen by what a shell session actually needs rather than by copying a
 *  keyboard: escape and tab, the four arrows, and Ctrl to reach the rest. The
 *  list is short on purpose — a bar that wraps to three rows on a phone has
 *  taken the screen the terminal was supposed to be using.
 */
export const TOUCH_KEYS: TouchKey[] = [
  { id: "ctrl", label: "Ctrl", send: null, sticky: true, title: "Control" },
  { id: "esc", label: "Esc", send: ESC, title: "Escape" },
  { id: "tab", label: "Tab", send: "\t", title: "Tab" },
  // The cursor keys in their ordinary (non-application) mode, which is what a
  // shell's line editor reads.
  { id: "up", label: "↑", send: `${ESC}[A`, title: "Up arrow" },
  { id: "down", label: "↓", send: `${ESC}[B`, title: "Down arrow" },
  { id: "left", label: "←", send: `${ESC}[D`, title: "Left arrow" },
  { id: "right", label: "→", send: `${ESC}[C`, title: "Right arrow" },
  // Ctrl+C by name as well as by modifier. It is the reason this bar exists,
  // and making somebody arm a modifier first to reach it would be putting the
  // most-needed key two taps away.
  { id: "sigint", label: "^C", send: controlByte("C"), title: "Interrupt" },
];

/** What to send for a keypress while `Ctrl` may be armed.
 *
 *  Returns both the bytes and whether the modifier is still armed afterwards,
 *  so the caller never has to remember to disarm it. Ctrl is one-shot: it
 *  applies to the next key and then lets go, which is how a modifier behaves
 *  on a real keyboard and is the only behaviour that does not strand somebody
 *  in a mode they cannot see.
 */
export interface KeyResult {
  send: string | null;
  ctrlArmed: boolean;
}

export function pressTouchKey(key: TouchKey, ctrlArmed: boolean): KeyResult {
  if (key.sticky) {
    // Tapping Ctrl again disarms it, so an accidental tap is undoable without
    // sending anything.
    return { send: null, ctrlArmed: !ctrlArmed };
  }

  // A control key with Ctrl armed is left alone: Ctrl+Escape and Ctrl+Up are
  // not things this bar claims to produce, and sending the plain sequence is
  // the honest fallback.
  return { send: key.send, ctrlArmed: false };
}

/** What to send for an ordinary typed character while Ctrl may be armed.
 *
 *  This is the half that makes the modifier worth having: with Ctrl armed, `d`
 *  becomes 0x04 and ends the shell, `z` becomes 0x1a and suspends it.
 */
export function pressCharacter(character: string, ctrlArmed: boolean): KeyResult {
  if (!ctrlArmed) return { send: character, ctrlArmed: false };

  const control = controlByte(character);

  // Ctrl+7 has no control byte. Sending the plain character is better than
  // swallowing the keystroke, which would look like the terminal had frozen.
  return { send: control ?? character, ctrlArmed: false };
}
