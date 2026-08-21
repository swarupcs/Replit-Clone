import { describe, expect, it } from "vitest";
import { parseSegments } from "./markdown.ts";

describe("parseSegments", () => {
  it("returns nothing for empty or blank input", () => {
    expect(parseSegments("")).toEqual([]);
    expect(parseSegments("   \n\n  ")).toEqual([]);
  });

  it("treats plain prose as one text segment", () => {
    expect(parseSegments("Hello there.\nSecond line.")).toEqual([
      { kind: "text", content: "Hello there.\nSecond line." },
    ]);
  });

  it("pulls a fenced block out, keeping its language", () => {
    const segments = parseSegments(
      ["Try this:", "```ts", "const x = 1;", "```", "That should do it."].join("\n"),
    );

    expect(segments).toEqual([
      { kind: "text", content: "Try this:" },
      { kind: "code", language: "ts", content: "const x = 1;", closed: true },
      { kind: "text", content: "That should do it." },
    ]);
  });

  it("leaves the language undefined on a bare fence", () => {
    const segments = parseSegments(["```", "plain", "```"].join("\n"));

    expect(segments).toEqual([
      { kind: "code", content: "plain", closed: true },
    ]);
  });

  it("keeps blank lines and indentation inside a block", () => {
    const code = ["function f() {", "", "  return 1;", "}"].join("\n");
    const segments = parseSegments(["```js", code, "```"].join("\n"));

    expect(segments[0]).toMatchObject({ kind: "code", content: code });
  });

  it("handles several blocks in one answer", () => {
    const segments = parseSegments(
      ["First:", "```sh", "npm i", "```", "Then:", "```ts", "run();", "```"].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "code",
      "text",
      "code",
    ]);
  });

  /** Mid-stream the closing fence has not arrived. Showing the code as it
   *  lands beats flickering between prose and code on every chunk. */
  it("emits an unterminated block as open", () => {
    const segments = parseSegments(["Here:", "```py", "print(1)"].join("\n"));

    expect(segments).toEqual([
      { kind: "text", content: "Here:" },
      { kind: "code", language: "py", content: "print(1)", closed: false },
    ]);
  });

  it("emits an open block even when it is still empty", () => {
    const segments = parseSegments("```ts");

    expect(segments).toEqual([
      { kind: "code", language: "ts", content: "", closed: false },
    ]);
  });

  /** A longer fence is how Markdown nests one example inside another; closing
   *  on the inner ``` would cut the example in half. */
  it("does not let an inner fence close a longer one", () => {
    const segments = parseSegments(
      ["````md", "```ts", "const x = 1;", "```", "````"].join("\n"),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "code",
      language: "md",
      content: "```ts\nconst x = 1;\n```",
      closed: true,
    });
  });

  it("does not treat a fence with trailing text as a closing one", () => {
    const segments = parseSegments(["```ts", "const x = 1;", "``` and more"].join("\n"));

    expect(segments[0]).toMatchObject({ closed: false });
  });

  it("tolerates a fence indented up to three spaces", () => {
    const segments = parseSegments(["   ```ts", "x", "   ```"].join("\n"));

    expect(segments[0]).toMatchObject({ kind: "code", closed: true });
  });

  it("drops whitespace-only prose between blocks", () => {
    const segments = parseSegments(
      ["```ts", "a", "```", "", "   ", "```ts", "b", "```"].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["code", "code"]);
  });

  /** Prose is rendered as text, never as markup — so nothing the model writes
   *  can become an element. */
  it("leaves HTML in prose as literal text", () => {
    const segments = parseSegments("Use <script>alert(1)</script> carefully.");

    expect(segments).toEqual([
      { kind: "text", content: "Use <script>alert(1)</script> carefully." },
    ]);
  });
});
