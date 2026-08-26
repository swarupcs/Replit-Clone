import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, into);
    else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      into.push(path);
    }
  }
  return into;
}

/** The opening tag starting at `from`, e.g. `<button ... >`.
 *
 *  Scanned rather than matched with a regular expression, because JSX puts
 *  `>` inside braces all the time — `onClick={() => ...}` ends a tag by
 *  accident, and a naive match then reads the *next* element's attributes as
 *  this one's. Brace depth is what tells the two apart.
 */
function openingTag(source: string, from: number): string {
  let depth = 0;

  for (let at = from; at < source.length; at += 1) {
    const char = source[at];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(from, at + 1);
  }

  return source.slice(from);
}

/** Icon buttons whose element carries no `aria-label`.
 *
 *  Read from the source rather than from a render, because the point is that
 *  it holds for every one of them, in components a test would otherwise have
 *  to mount a socket, a container and Monaco to reach.
 */
function unlabelled(): string[] {
  const found: string[] = [];

  for (const path of sources(root)) {
    const source = readFileSync(path, "utf8");

    for (const match of source.matchAll(/<button\b/g)) {
      const tag = openingTag(source, match.index);
      if (!tag.includes('className="rc-icon-button')) continue;
      if (tag.includes("aria-label")) continue;

      const line = source.slice(0, match.index).split("\n").length;
      found.push(`${path.slice(root.length)}:${String(line)}`);
    }
  }

  return found;
}

describe("icon-only buttons", () => {
  /** A tooltip is not a label. It never reaches a screen reader, and a touch
   *  device never shows one at all — so an icon button with only a tooltip is
   *  unlabelled for everyone who is not using a mouse and their eyes. */
  it("all carry an accessible name", () => {
    expect(unlabelled()).toEqual([]);
  });
});
