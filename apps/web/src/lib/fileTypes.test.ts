import { describe, expect, it } from "vitest";
import {
  BY_EXTENSION,
  BY_NAME,
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  FOLDER_BY_NAME,
  fileTypeFor,
  folderTypeFor,
  type FileType,
} from "./fileTypes.ts";
import { extensionToFileType } from "../utils/extensionToFileType.ts";

const entries = (): [string, FileType][] => [
  ...Object.entries(BY_EXTENSION),
  ...Object.entries(BY_NAME),
];

describe("the file type table", () => {
  /** The asymmetry this row exists to remove: the language map used to be
   *  wider than the icon map, so a `.rs` file was highlighted as Rust under
   *  a generic glyph. With one table it cannot recur by omission — but it
   *  can still recur by someone adding a half-filled entry, which is what
   *  these two check. */
  it("gives every entry an icon", () => {
    for (const [key, type] of entries()) {
      expect(type.icon, `"${key}" has no icon`).toBeTypeOf("function");
    }
  });

  it("gives every entry a colour", () => {
    for (const [key, type] of entries()) {
      expect(type.color, `"${key}" has no colour`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  /** `null` is the deliberate "this format has no Monaco language"; an
   *  empty string or a stray `undefined` is someone having meant to fill it
   *  in. Keeping those distinguishable is the point of using `null`. */
  it("states a language or states that there is none", () => {
    for (const [key, type] of entries()) {
      expect(type, `"${key}" is missing the language key`).toHaveProperty("language");
      if (type.language !== null) {
        expect(type.language, `"${key}" has an empty language`).toBeTruthy();
        expect(type.language, `"${key}" has a non-string language`).toBeTypeOf("string");
      }
    }
  });

  it("keys extensions lowercase and without a dot", () => {
    for (const key of Object.keys(BY_EXTENSION)) {
      expect(key, `"${key}" is not a bare lowercase extension`).toMatch(
        /^[a-z0-9]+$/,
      );
    }
  });

  it("keys names lowercase, since lookup lowercases before matching", () => {
    for (const key of Object.keys(BY_NAME)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  /** Every language named here has to be one Monaco actually knows, or the
   *  file silently gets no highlighting — the failure the old `svg: "svg"`
   *  entry caused, where a plausible-looking id was not a real one. */
  it("only names languages Monaco ships", () => {
    const known = new Set([
      "javascript", "typescript", "html", "css", "scss", "less", "json",
      "yaml", "ini", "xml", "markdown", "plaintext", "python", "ruby", "go",
      "rust", "java", "kotlin", "swift", "c", "cpp", "csharp", "php", "perl",
      "lua", "r", "scala", "dart", "sql", "graphql", "shell", "powershell",
      "dockerfile",
    ]);

    for (const [key, type] of entries()) {
      if (type.language === null) continue;
      expect(known, `"${key}" claims the unknown language "${type.language}"`).toContain(
        type.language,
      );
    }
  });
});

describe("fileTypeFor", () => {
  it("prefers the whole name over the extension", () => {
    expect(fileTypeFor("json", "package.json")).toBe(BY_NAME["package.json"]);
    expect(fileTypeFor("json", "some-other.json")).toBe(BY_EXTENSION.json);
  });

  it("matches a name's first segment, so Dockerfile.dev is a Dockerfile", () => {
    expect(fileTypeFor("dev", "Dockerfile.dev")).toBe(BY_NAME.dockerfile);
  });

  it("treats every .env variant as an env file", () => {
    expect(fileTypeFor(undefined, ".env.production")).toBe(BY_NAME[".env"]);
    expect(fileTypeFor("local", ".env.local")).toBe(BY_NAME[".env"]);
  });

  it("is case-insensitive on both", () => {
    expect(fileTypeFor("TS")).toBe(BY_EXTENSION.ts);
    expect(fileTypeFor(undefined, "DOCKERFILE")).toBe(BY_NAME.dockerfile);
  });

  it("returns undefined for a file it does not know", () => {
    expect(fileTypeFor("qqq")).toBeUndefined();
    expect(fileTypeFor(undefined)).toBeUndefined();
  });
});

describe("extensionToFileType", () => {
  /** The accessor's contract did not change when the table behind it did.
   *  These are the cases the old map got wrong or right for reasons worth
   *  keeping. */
  it("still answers for the languages it always did", () => {
    expect(extensionToFileType("ts")).toBe("typescript");
    expect(extensionToFileType("py")).toBe("python");
    expect(extensionToFileType("rs")).toBe("rust");
    expect(extensionToFileType("svg")).toBe("xml");
  });

  it("reports a format with no language the same as an unknown one", () => {
    expect(extensionToFileType("png")).toBeUndefined();
    expect(extensionToFileType("qqq")).toBeUndefined();
  });

  it("covers the extensions the icon map used to know and it did not", () => {
    // The bug in the other direction: these had icons and no language.
    for (const extension of ["vue", "svelte", "prisma", "tf", "proto"]) {
      expect(extensionToFileType(extension), extension).toBeTruthy();
    }
  });
});

describe("folderTypeFor", () => {
  it("gives a known folder its own colour", () => {
    expect(folderTypeFor("src")).toBe(FOLDER_BY_NAME.src);
    expect(folderTypeFor("node_modules")).toBe(FOLDER_BY_NAME.node_modules);
  });

  it("is case-insensitive", () => {
    expect(folderTypeFor("SRC")).toBe(FOLDER_BY_NAME.src);
  });

  it("falls back rather than returning nothing", () => {
    expect(folderTypeFor("whatever")).toBe(DEFAULT_FOLDER);
  });

  it("gives every folder a distinct open and closed glyph", () => {
    for (const [key, type] of Object.entries(FOLDER_BY_NAME)) {
      expect(type.open, `"${key}" reuses one glyph for both states`).not.toBe(
        type.closed,
      );
      expect(type.color, `"${key}" has no colour`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("the fallbacks", () => {
  it("render something rather than nothing", () => {
    expect(DEFAULT_FILE.icon).toBeTypeOf("function");
    expect(DEFAULT_FOLDER.closed).toBeTypeOf("function");
    expect(DEFAULT_FOLDER.open).toBeTypeOf("function");
  });
});
