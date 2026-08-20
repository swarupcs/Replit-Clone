import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzyScore.ts";

/** Ranks a candidate list the way QuickOpen does. */
function rank(candidates: string[], query: string): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: fuzzyScore(candidate, query) }))
    .filter(
      (entry): entry is { candidate: string; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.candidate);
}

describe("fuzzyScore", () => {
  it("matches a plain substring", () => {
    expect(fuzzyScore("src/App.tsx", "app")).not.toBeNull();
  });

  it("matches scattered characters, not just substrings", () => {
    expect(fuzzyScore("src/App.tsx", "sat")).not.toBeNull();
  });

  it("returns null when a character is missing", () => {
    expect(fuzzyScore("src/App.tsx", "zzz")).toBeNull();
  });

  it("returns null when the characters are present but out of order", () => {
    expect(fuzzyScore("abc.ts", "cba")).toBeNull();
  });

  it("treats an empty query as a match on everything", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  it("is case-insensitive in both directions", () => {
    expect(fuzzyScore("src/App.tsx", "APP")).toBe(fuzzyScore("SRC/APP.TSX", "app"));
  });

  it("ranks a filename match above a directory match", () => {
    const ranked = rank(["src/app/deep/other.ts", "src/App.tsx"], "app");
    expect(ranked[0]).toBe("src/App.tsx");
  });

  it("prefers adjacent characters over scattered ones", () => {
    const adjacent = fuzzyScore("main.ts", "main");
    const scattered = fuzzyScore("m-a-i-n.ts", "main");
    expect(adjacent).toBeLessThan(scattered as number);
  });

  it("prefers the shorter of two otherwise equal matches", () => {
    const ranked = rank(["index.ts", "index.stories.ts"], "index");
    expect(ranked[0]).toBe("index.ts");
  });
});
