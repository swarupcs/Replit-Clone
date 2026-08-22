import { describe, expect, it } from "vitest";
import { shouldReseedFromServer, type ReseedInput } from "./bufferReseed.ts";

const OPENED = "export default function Home() {\n  return <h1>hi</h1>;\n}\n";
const TYPED = `${OPENED}// a line the user added\n`;

/** The state right after a file is opened and left alone. */
function base(over: Partial<ReseedInput> = {}): ReseedInput {
  return {
    seeded: OPENED,
    tabValue: OPENED,
    modelValue: OPENED,
    isDirty: false,
    isShared: false,
    ...over,
  };
}

/** The reported bug, in both the shared and unshared shapes.
 *
 *  Type a line, press Ctrl+S. The save lands, the unsaved marker is cleared,
 *  and clearing it rebuilds the tab object — which re-runs the effect that
 *  decides this. `tabValue` is still the snapshot from when the file was
 *  opened, so the old rule saw a difference and put those contents back,
 *  taking the typed line with them.
 */
describe("just after a successful save", () => {
  it("does not put the opened contents back over what was saved", () => {
    expect(
      shouldReseedFromServer(
        base({ modelValue: TYPED, isDirty: false, isShared: true }),
      ),
    ).toBe(false);
  });

  it("does not do it for an unshared file either", () => {
    // The same path via writeFileSuccess, which clears the marker too.
    expect(
      shouldReseedFromServer(base({ modelValue: TYPED, isDirty: false })),
    ).toBe(false);
  });

  it("still refuses once the buffer has moved on again", () => {
    // Typed more after saving: the snapshot has not changed, so it is still
    // not evidence of anything.
    expect(
      shouldReseedFromServer(
        base({ modelValue: `${TYPED}more\n`, isDirty: true }),
      ),
    ).toBe(false);
  });
});

/** What the reseed is actually for: the server sent contents this buffer has
 *  not seen, e.g. the file was reopened, or changed on disk. */
describe("when the server sends new contents", () => {
  it("takes them", () => {
    expect(
      shouldReseedFromServer(
        base({ seeded: OPENED, tabValue: TYPED, modelValue: OPENED }),
      ),
    ).toBe(true);
  });

  it("takes them for a buffer that was never seeded", () => {
    expect(
      shouldReseedFromServer(
        base({ seeded: undefined, tabValue: TYPED, modelValue: OPENED }),
      ),
    ).toBe(true);
  });

  it("leaves unsaved local edits alone", () => {
    expect(
      shouldReseedFromServer(
        base({ tabValue: TYPED, modelValue: "half-typed", isDirty: true }),
      ),
    ).toBe(false);
  });

  /** The shared document is the source of truth, and the snapshot is a disk
   *  read that may already be behind it. */
  it("never overwrites a shared buffer", () => {
    expect(
      shouldReseedFromServer(
        base({ tabValue: TYPED, modelValue: OPENED, isShared: true }),
      ),
    ).toBe(false);
  });

  it("does nothing when the buffer already matches", () => {
    expect(
      shouldReseedFromServer(
        base({ seeded: OPENED, tabValue: TYPED, modelValue: TYPED }),
      ),
    ).toBe(false);
  });
});
