import { env } from "../config/env.js";

export interface LanguageServer {
  /** What to exec inside the container. Must be on PATH in one of `images`. */
  argv: string[];
  /** The sandbox images that carry it.
   *
   *  Load-bearing, not documentation. A `.py` file can be opened in a Node
   *  project, and asking that container for `pylsp` gets "executable file not
   *  found" halfway through a WebSocket handshake -- a failure with no reason
   *  attached, arriving at a client that has already been told the server was
   *  starting. Checked up front instead, and refused with a sentence.
   *
   *  A LIST since §10.8, and not for tidiness: `typescript-language-server`
   *  ships in the node image, and a TypeScript file is opened in projects
   *  built on it constantly. One image per language was a fair description of
   *  a registry with two entries and became wrong the moment a server belonged
   *  to more than one.
   */
  images: string[];
}

/** Language servers this platform knows how to start, by Monaco language id. */
export const LANGUAGE_SERVERS: Record<string, LanguageServer> = {
  // Python first: the sandbox image already carries a toolchain that knows all
  // of this and was never asked.
  python: {
    argv: ["pylsp"],
    images: ["sandbox-python:latest"],
  },
  // Go second, and cheap: one registry entry and a `go install` in the image
  // that already ships the compiler. Everything underneath -- the gateway, the
  // Content-Length framing, lazy start, idle stop, the memory refusal -- was
  // built for the first one and is language-agnostic.
  go: {
    argv: ["gopls", "serve"],
    images: ["sandbox-go:latest"],
  },
  // TypeScript and JavaScript -- plan.md §10.8, and the most valuable entry
  // here. Monaco ships its own TS worker and it is PER MODEL: it sees the file
  // you have open and not the project around it, so a rename is a rename in one
  // buffer and "go to definition" across files is a guess. `tsserver` behind
  // `typescript-language-server` sees the project.
  //
  // Both ids point at one server because tsserver handles both, which is also
  // why JS files in a TS project get the project's types.
  typescript: {
    argv: ["typescript-language-server", "--stdio"],
    images: ["sandbox-node:latest"],
  },
  javascript: {
    argv: ["typescript-language-server", "--stdio"],
    images: ["sandbox-node:latest"],
  },
  // Rust and C/C++ need images this repository does not build yet -- see
  // `images/rust` and `images/cpp`, added with this row. Listed here so the
  // refusal names the image rather than saying the language is unsupported,
  // which would be wrong in a different way.
  rust: {
    argv: ["rust-analyzer"],
    images: ["sandbox-rust:latest"],
  },
  cpp: {
    argv: ["clangd", "--background-index"],
    images: ["sandbox-cpp:latest"],
  },
  c: {
    argv: ["clangd", "--background-index"],
    images: ["sandbox-cpp:latest"],
  },
};

/** Whether a server can run in a given image.
 *
 *  Exported and separate from `canStartLanguageServer` so the LIST behaviour is
 *  exercised rather than latent: every entry in the registry happens to name
 *  one image today, so a check written inline would pass identically if it
 *  compared only the first — which is a bug waiting for the second image.
 */
export function servesImage(
  server: LanguageServer,
  projectImage: string,
): boolean {
  return server.images.includes(projectImage);
}

/** "a sandbox-node:latest container" or "one of A, B". Written out because the
 *  refusal is read by somebody deciding what to do about it. */
function listImages(images: readonly string[]): string {
  if (images.length === 1) return `a ${images[0] ?? ""} container`;
  return `one of ${images.join(", ")}`;
}

export type LspRefusal =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "DISABLED"
        | "UNSUPPORTED_LANGUAGE"
        | "WRONG_IMAGE"
        | "NOT_ENOUGH_MEMORY";
      message: string;
    };

/** Whether a language server may be started, and if not, why.
 *
 *  The memory policy of `docs/ROADMAP.md` §6, decision 3, in place from the
 *  first commit rather than added after the first OOM. The refusal
 *  carries a message because the alternative — starting a server and letting
 *  the dev server be killed for memory — is a failure the user cannot
 *  diagnose and did not cause.
 */
export function canStartLanguageServer(
  language: string,
  /** The image the project's container actually runs. Optional so a caller
   *  that has not resolved the template yet can still ask the cheap questions;
   *  when it is known, the check is made. */
  projectImage?: string,
): LspRefusal {
  if (!env.LSP_ENABLED) {
    return {
      allowed: false,
      code: "DISABLED",
      message: "Language servers are not enabled on this deployment.",
    };
  }

  if (!(language in LANGUAGE_SERVERS)) {
    return {
      allowed: false,
      code: "UNSUPPORTED_LANGUAGE",
      message: `No language server is available for ${language} yet.`,
    };
  }

  const server = LANGUAGE_SERVERS[language];

  if (server && projectImage !== undefined && !servesImage(server, projectImage)) {
    return {
      allowed: false,
      code: "WRONG_IMAGE",
      // Named both ways round, because the fix is the user's to choose: they
      // can open the file in a project of that language, or not expect
      // intelligence for a file that is a passenger in this one.
      message:
        `${language} intelligence needs ${listImages(server.images)}; this ` +
        `project runs ${projectImage}. Open the file in a ${language} project ` +
        `to get it.`,
    };
  }

  if (env.CONTAINER_MEMORY_MB < env.LSP_MIN_CONTAINER_MEMORY_MB) {
    return {
      allowed: false,
      code: "NOT_ENOUGH_MEMORY",
      // Said plainly, with the number, so an operator can act on it.
      message:
        `Language intelligence needs a container memory limit of at least ` +
        `${String(env.LSP_MIN_CONTAINER_MEMORY_MB)} MB; this deployment allows ` +
        `${String(env.CONTAINER_MEMORY_MB)} MB. Starting one here would risk ` +
        `the dev server being killed for memory instead.`,
    };
  }

  return { allowed: true };
}
