import { fuzzyScore } from "../utils/fuzzyScore.ts";

/** One entry in the command palette. */
export interface Command {
  /** Stable identity, used as the React key and in tests. */
  id: string;
  /** What the palette shows, and what the query is matched against. */
  title: string;
  /** Groups related commands, and is matched too -- so "git" finds the
   *  source-control commands without their titles having to repeat the word. */
  category: string;
  /** Rendered on the right, e.g. "Ctrl+P". Display only: the shortcut itself is
   *  registered with useHotkeys, not here, so the two cannot disagree about
   *  what a key does -- only about how it is spelled. */
  keys?: string;
  /** False greys the entry out and refuses to run it. A viewer cannot start a
   *  dev server, and a command that silently does nothing is worse than one
   *  that says why it cannot. */
  enabled?: boolean;
  /** Why it is unavailable, shown in place of the shortcut. */
  disabledReason?: string;
  run: () => void;
}

const MAX_RESULTS = 50;

/** Ranks commands against a query, best first.
 *
 *  Matched against "Category: Title" so either half can find an entry, which is
 *  how every editor's palette behaves -- typing "git" should reach "Source
 *  control: Commit" even though its title says nothing about git.
 *
 *  An empty query keeps the declaration order rather than an arbitrary one:
 *  the list is short and hand-ordered by how often each is wanted.
 *
 *  Disabled commands are kept rather than hidden. A palette that silently omits
 *  "Stop" while a run is starting reads as a missing feature; one that shows it
 *  greyed with a reason explains itself.
 */
export function filterCommands(
  commands: Command[],
  query: string,
): Command[] {
  const trimmed = query.trim();
  if (!trimmed) return commands.slice(0, MAX_RESULTS);

  const scored: { command: Command; score: number }[] = [];

  for (const command of commands) {
    const score = fuzzyScore(`${command.category}: ${command.title}`, trimmed);
    if (score !== null) scored.push({ command, score });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_RESULTS).map((entry) => entry.command);
}
