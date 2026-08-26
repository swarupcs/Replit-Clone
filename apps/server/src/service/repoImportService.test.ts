import { describe, expect, it } from "vitest";
import { detectTemplate } from "./repoImportService.js";

/** What `inspectClone` hands over: the top-level entries, plus the parsed
 *  package.json when there is one. */
function pkg(deps: Record<string, string>, dev: Record<string, string> = {}) {
  return { dependencies: deps, devDependencies: dev };
}

describe("detectTemplate", () => {
  describe("JavaScript", () => {
    it("recognises a Vite React app", () => {
      expect(detectTemplate(["package.json"], pkg({ react: "^19" }))).toBe(
        "react-vite",
      );
    });

    it("takes TypeScript from a tsconfig or the dependency", () => {
      expect(
        detectTemplate(["package.json", "tsconfig.json"], pkg({ react: "^19" })),
      ).toBe("react-vite-ts");

      expect(
        detectTemplate(["package.json"], pkg({ react: "^19" }, { typescript: "^5" })),
      ).toBe("react-vite-ts");
    });

    it("prefers Next.js over React, which it also is", () => {
      // A Next.js app has react in its dependencies; ordering is the whole
      // reason this is a function rather than a lookup.
      expect(
        detectTemplate(["package.json", "next.config.js"], pkg({ react: "^19", next: "^15" })),
      ).toBe("nextjs");
    });

    it("recognises Vue and Svelte", () => {
      expect(detectTemplate(["package.json"], pkg({ vue: "^3" }))).toBe("vue-vite");
      expect(detectTemplate(["package.json"], pkg({ svelte: "^5" }))).toBe(
        "svelte-vite",
      );
      expect(
        detectTemplate(["package.json"], pkg({ "@sveltejs/kit": "^2" })),
      ).toBe("svelte-vite");
    });

    it("recognises a server, whichever framework", () => {
      for (const framework of ["express", "fastify", "koa"]) {
        expect(
          detectTemplate(["package.json"], pkg({ [framework]: "^1" })),
        ).toBe("node-express");
      }
    });

    it("falls back to Node for a package.json it does not recognise", () => {
      // It is a Node project of some kind, and the Node image is the one that
      // can install and run it.
      expect(detectTemplate(["package.json"], pkg({ lodash: "^4" }))).toBe(
        "node-express",
      );
    });
  });

  describe("other languages", () => {
    it("recognises Go", () => {
      expect(detectTemplate(["go.mod", "main.go"], null)).toBe("go-http");
    });

    it("tells FastAPI from Flask by what the requirements name", () => {
      // The two templates differ in start command and port; guessing means a
      // preview that never comes up.
      expect(detectTemplate(["requirements.txt"], null)).toBe("python-flask");
      expect(detectTemplate(["requirements.txt", "__fastapi__"], null)).toBe(
        "python-fastapi",
      );
    });

    it("recognises Python from pyproject or Pipfile too", () => {
      expect(detectTemplate(["pyproject.toml"], null)).toBe("python-flask");
      expect(detectTemplate(["Pipfile"], null)).toBe("python-flask");
    });

    it("puts Go ahead of everything, since go.mod is unambiguous", () => {
      expect(detectTemplate(["go.mod", "package.json"], pkg({ react: "^19" }))).toBe(
        "go-http",
      );
    });
  });

  describe("no build system at all", () => {
    it("recognises a plain site", () => {
      expect(detectTemplate(["index.html", "style.css"], null)).toBe("static-html");
    });

    it("gives an unrecognisable repository the Node image", () => {
      // Nothing to run, so what matters is what the person gets to work in: a
      // shell, git and a package manager.
      expect(detectTemplate(["README.md", "LICENSE"], null)).toBe("node-express");
      expect(detectTemplate([], null)).toBe("node-express");
    });
  });
});
