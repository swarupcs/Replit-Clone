import { describe, expect, it } from "vitest";
import { extensionToFileType } from "./extensionToFileType.ts";

describe("extensionToFileType", () => {
  it.each([
    ["ts", "typescript"],
    ["tsx", "typescript"],
    ["js", "javascript"],
    ["jsx", "javascript"],
    ["json", "json"],
    ["css", "css"],
    ["scss", "scss"],
    ["html", "html"],
    ["md", "markdown"],
    ["yml", "yaml"],
  ])("maps .%s to %s", (extension, expected) => {
    expect(extensionToFileType(extension)).toBe(expected);
  });

  it("highlights Python, which the shipped template needs", () => {
    expect(extensionToFileType("py")).toBe("python");
  });

  it("treats SVG as XML rather than a language Monaco does not have", () => {
    expect(extensionToFileType("svg")).toBe("xml");
  });

  it.each([
    ["sh", "shell"],
    ["sql", "sql"],
    ["go", "go"],
    ["rs", "rust"],
    ["java", "java"],
    ["c", "c"],
    ["cpp", "cpp"],
    ["php", "php"],
    ["rb", "ruby"],
    ["toml", "ini"],
    ["xml", "xml"],
  ])("covers .%s", (extension, expected) => {
    expect(extensionToFileType(extension)).toBe(expected);
  });

  it("is case-insensitive about the extension", () => {
    expect(extensionToFileType("TS")).toBe("typescript");
    expect(extensionToFileType("PY")).toBe("python");
  });

  it("recognises extensionless files by name", () => {
    expect(extensionToFileType(undefined, "Dockerfile")).toBe("dockerfile");
    expect(extensionToFileType(undefined, "Makefile")).toBe("shell");
    expect(extensionToFileType(undefined, "Gemfile")).toBe("ruby");
  });

  it("prefers the name over a misleading extension", () => {
    // "Dockerfile.dev" is a Dockerfile, not a ".dev" file.
    expect(extensionToFileType("dev", "Dockerfile.dev")).toBe("dockerfile");
  });

  it("handles the whole .env family", () => {
    expect(extensionToFileType(undefined, ".env")).toBe("shell");
    expect(extensionToFileType("local", ".env.local")).toBe("shell");
    expect(extensionToFileType("production", ".env.production")).toBe("shell");
  });

  it("returns undefined for an unknown format, so Monaco falls back to text", () => {
    expect(extensionToFileType("wat")).toBeUndefined();
    expect(extensionToFileType(undefined)).toBeUndefined();
  });
});
