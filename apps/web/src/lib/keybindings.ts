/** One chord.
 *
 *  `mod` is Ctrl on Windows and Linux and Cmd on macOS — matched against
 *  whichever the platform uses, so one definition covers both. */
export interface Chord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** A chord bound to a command.
 *
 *  The registry exists because the chord and its display string used to be
 *  written in two places — the `keys:` field on a command and the
 *  `useHotkeys` list — kept in step by hand, with nothing checking. The
 *  display string was free text, so it could say Ctrl+K while the handler
 *  listened for Ctrl+L and no test would notice.
 */
export const DEFAULT_KEYBINDINGS: Record<string, Chord> = {
  "go.file": { key: "p", mod: true },
  "go.command": { key: "p", mod: true, shift: true },
  "go.symbol": { key: "t", mod: true },
  "view.search": { key: "f", mod: true, shift: true },
  "view.files": { key: "e", mod: true, shift: true },
  "view.git": { key: "g", mod: true, shift: true },
  "view.packages": { key: "d", mod: true, shift: true },
  "view.sidebar": { key: "b", mod: true },
  "view.panel": { key: "`", mod: true },
  "view.preview": { key: "j", mod: true },
  "view.zen": { key: "k", mod: true, alt: true },
  // Ctrl+W is the browser's own close-tab and cannot be reclaimed, so this
  // is the Alt variant.
  "file.closeTab": { key: "w", mod: true, alt: true },
  "file.reopenTab": { key: "t", mod: true, shift: true },
  "file.nextTab": { key: "Tab", mod: true },
};


/** True on a Mac, so the modifier renders as ⌘ rather than Ctrl.
 *
 *  Read once per call rather than cached, because a test needs to be able to
 *  ask for either without reloading the module. */
export function isMac(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** How a chord is written in the palette.
 *
 *  Derived rather than typed, which is the whole point of the registry: the
 *  string cannot disagree with the chord because there is only one chord. */
export function formatChord(chord: Chord, mac = isMac()): string {
  const parts: string[] = [];

  // Order matches what each platform's own menus use, so the string looks
  // native rather than merely correct.
  if (mac) {
    if (chord.alt) parts.push("⌥");
    if (chord.shift) parts.push("⇧");
    if (chord.mod) parts.push("⌘");
  } else {
    if (chord.mod) parts.push("Ctrl");
    if (chord.shift) parts.push("Shift");
    if (chord.alt) parts.push("Alt");
  }

  const key =
    chord.key.length === 1 ? chord.key.toUpperCase() : capitalise(chord.key);
  parts.push(key);

  return mac ? parts.join("") : parts.join("+");
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A stable string for a chord, for comparing two of them.
 *
 *  Modifiers in a fixed order so `{mod, shift}` and `{shift, mod}` — the same
 *  chord written differently — compare equal. */
export function chordKey(chord: Chord): string {
  return [
    chord.mod ? "mod" : "",
    chord.shift ? "shift" : "",
    chord.alt ? "alt" : "",
    chord.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join("+");
}

/** Commands whose chords collide.
 *
 *  Two commands on one chord is not a crash — the first handler wins and the
 *  second silently never fires, which is worse, because it looks like a
 *  broken feature rather than a broken binding. */
export function conflicts(
  bindings: Record<string, Chord>,
): { chord: string; commandIds: string[] }[] {
  const byChord = new Map<string, string[]>();

  for (const [commandId, chord] of Object.entries(bindings)) {
    const key = chordKey(chord);
    byChord.set(key, [...(byChord.get(key) ?? []), commandId]);
  }

  return [...byChord.entries()]
    .filter(([, commandIds]) => commandIds.length > 1)
    .map(([chord, commandIds]) => ({ chord, commandIds }));
}

/** The bindings in force: the defaults, with any the user has changed.
 *
 *  An override naming a command that no longer exists is dropped rather than
 *  carried: a binding for nothing is invisible and would only surface as a
 *  chord that mysteriously does nothing. */
export function resolveBindings(
  overrides: Record<string, Chord>,
): Record<string, Chord> {
  const resolved = { ...DEFAULT_KEYBINDINGS };

  for (const [commandId, chord] of Object.entries(overrides)) {
    if (commandId in DEFAULT_KEYBINDINGS) resolved[commandId] = chord;
  }

  return resolved;
}
