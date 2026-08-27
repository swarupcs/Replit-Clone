import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, conflicts } from "./lib/keybindings.ts";

const playground = readFileSync(
  fileURLToPath(new URL("./pages/ProjectPlayground.tsx", import.meta.url)),
  "utf8",
);

/** The `handlers` map, as command ids. Read from the source because the map
 *  is built inside a component and there is nothing to import. */
function handlerIds(): string[] {
  const start = playground.indexOf("const handlers = useMemo");
  const end = playground.indexOf("const bindings = useKeybindingStore", start);
  const block = playground.slice(start, end);
  return [...block.matchAll(/^\s{6}"([\w.]+)":/gm)].map((match) => match[1] ?? "");
}

describe("the keybinding registry and its handlers", () => {
  /** The failure this registry exists to prevent: a chord registered with
   *  nothing behind it looks like a broken feature rather than a missing
   *  binding, because pressing it does nothing and says nothing. */
  it("has a handler for every chord it registers", () => {
    const handlers = new Set(handlerIds());
    for (const commandId of Object.keys(DEFAULT_KEYBINDINGS)) {
      expect(handlers, `no handler for "${commandId}"`).toContain(commandId);
    }
  });

  it("registers a chord for every handler it defines", () => {
    for (const commandId of handlerIds()) {
      expect(
        DEFAULT_KEYBINDINGS,
        `"${commandId}" has a handler but no chord`,
      ).toHaveProperty(commandId);
    }
  });

  it("binds no chord to two commands", () => {
    expect(conflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });

  /** The other half of the old problem: `keys:` was free text, so the
   *  palette could say one thing while the handler listened for another. */
  it("types no shortcut string by hand", () => {
    expect(playground).not.toMatch(/keys:\s*"/);
  });

  it("reads its handler list from a map this test can actually see", () => {
    // A guard on the guard: if the map is restructured so the regex above
    // finds nothing, every assertion in this file would pass vacuously.
    expect(handlerIds().length).toBeGreaterThan(5);
  });
});
