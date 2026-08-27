import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Node rather than jsdom on purpose: this reads two files off disk, and under
// jsdom `import.meta.url` is an http:// URL that `fileURLToPath` refuses.

describe("the MongoDB stylesheet", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../../index.css", import.meta.url)),
    "utf8",
  );
  const source = readFileSync(
    fileURLToPath(new URL("./MongoWorkbench.tsx", import.meta.url)),
    "utf8",
  );

  /** The mistake the reduced-motion exemption and zen mode both nearly
   *  shipped with: a rule pointed at a class nobody sets does nothing and
   *  reads as handled. */
  /** Named explicitly rather than sliced out of the sheet by comment
   *  position: a boundary that moves when someone adds a comment is a guard
   *  that quietly stops guarding. */
  const ADDED = [
    "rc-db-engine-tag",
    "rc-db-empty",
    "rc-db-inferred",
    "rc-db-presence",
    "rc-mongo-doc",
    "rc-mongo-doc-head",
    "rc-mongo-doc-index",
    "rc-mongo-doc-summary",
    "rc-mongo-doc-body",
  ];

  it.each(ADDED)("styles %s, which the component sets", (className) => {
    expect(css, `${className} is not styled`).toContain(`.${className}`);
    expect(source, `${className} is styled but never set`).toContain(className);
  });

  /** The mistake the reduced-motion exemption and zen mode both nearly
   *  shipped with: a rule pointed at a class nobody sets does nothing and
   *  reads as handled. This sweeps the whole sheet rather than one block, so
   *  an invented class cannot hide by being declared somewhere else. */
  it("has no rc-mongo class the component never sets", () => {
    const styled = new Set(
      [...css.matchAll(/\.(rc-mongo-[a-z0-9-]+)/g)].map((match) => match[1] as string),
    );

    expect(styled.size).toBeGreaterThan(4);
    for (const className of styled) {
      expect(source.includes(className), `${className} is styled but never set`).toBe(
        true,
      );
    }
  });
});
