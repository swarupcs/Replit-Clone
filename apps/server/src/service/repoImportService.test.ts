import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  detectStartCommand,
  detectTemplate,
} from "./repoImportService.js";

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


/** A template's start command is right for a project scaffolded from it and
 *  usually wrong for somebody's real repository, whose own script is not in a
 *  fixed registry of a dozen templates. */
describe("detectStartCommand", () => {
  const scripts = (value: Record<string, string>) => ({ scripts: value });

  it("prefers dev over start", () => {
    // In a Vite or Next project `start` usually means the PRODUCTION server,
    // which needs a build that has not happened.
    expect(detectStartCommand(scripts({ start: "node .", dev: "vite" }))).toBe(
      "npm install && npm run dev",
    );
  });

  it("falls through dev, develop, start, serve in that order", () => {
    expect(detectStartCommand(scripts({ serve: "x", start: "y" }))).toBe(
      "npm install && npm run start",
    );
    expect(detectStartCommand(scripts({ serve: "x" }))).toBe(
      "npm install && npm run serve",
    );
  });

  it("installs first, since a fresh clone has no node_modules", () => {
    // A run that fails on a missing dependency looks like a broken import.
    expect(detectStartCommand(scripts({ dev: "vite" }))).toContain("npm install");
  });

  it("is null when there is nothing to go on", () => {
    // A wrong guess is worse than the template's default, which is at least
    // predictable from what the UI says the project is.
    expect(detectStartCommand(null)).toBeNull();
    expect(detectStartCommand({})).toBeNull();
    expect(detectStartCommand(scripts({ build: "tsc", test: "vitest" }))).toBeNull();
  });

  it("ignores a script that is present but empty", () => {
    expect(detectStartCommand(scripts({ dev: "   ", start: "node ." }))).toBe(
      "npm install && npm run start",
    );
  });
});

/** Which package manager a repository actually uses.
 *
 *  This existing at all is the fix for a real defect rather than a new
 *  capability, and the defect is the kind found by reading two shipped things
 *  against each other: `warmStart` fingerprints `pnpm-lock.yaml` and
 *  `yarn.lock` and knows how to skip `pnpm install` and `yarn install`, and
 *  `detectStartCommand` emitted `npm install` whatever had just been cloned. So
 *  the warm path was written for commands nothing ever produced, the lockfile
 *  was ignored -- which is the entire point of a lockfile -- and a
 *  `workspace:*` dependency, which npm cannot resolve at all, failed outright.
 */
describe("detectPackageManager", () => {
  it("reads the lockfile, which is the thing that always exists", () => {
    expect(detectPackageManager(["package.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["package.json", "yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(["package.json", "bun.lockb"])).toBe("bun");
  });

  /** A repository with no lockfile at all is genuinely an npm repository by
   *  default, so this is the right answer rather than a shrug. */
  it("is npm when there is nothing to go on", () => {
    expect(detectPackageManager(["package.json"])).toBe("npm");
    expect(detectPackageManager([])).toBe("npm");
    expect(detectPackageManager(["package.json", "package-lock.json"])).toBe("npm");
  });

  /** More than one lockfile means somebody migrated and did not finish. A
   *  stale `package-lock.json` left behind by a move TO pnpm is the common
   *  case; the reverse is not. */
  it("gives the newer tool the benefit when a migration was left half done", () => {
    expect(
      detectPackageManager(["package-lock.json", "pnpm-lock.yaml"]),
    ).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock", "pnpm-lock.yaml"])).toBe("pnpm");
  });
});

describe("the start command each manager gets", () => {
  const scripts = { scripts: { dev: "vite" } };

  /** `warmStart`'s INSTALL_PREFIXES already knows all of these, so an imported
   *  pnpm project takes the warm-start path from here on -- which it could
   *  never do while this always said npm. */
  it("installs with the manager the lockfile named", () => {
    expect(detectStartCommand(scripts, "pnpm")).toBe("pnpm install && pnpm run dev");
    expect(detectStartCommand(scripts, "bun")).toBe("bun install && bun run dev");
  });

  /** yarn takes no `run` for a script name. Getting this wrong produces a
   *  usage message rather than anything a person can act on. */
  it("uses each manager's own way of running a script", () => {
    expect(detectStartCommand(scripts, "yarn")).toBe("yarn install && yarn dev");
  });

  it("still defaults to npm when nobody said otherwise", () => {
    expect(detectStartCommand(scripts)).toBe("npm install && npm run dev");
  });
});
