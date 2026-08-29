import { env } from "../config/env.js";

export interface LanguageServer {
  /** What to exec inside the container. Must be on PATH in `image`. */
  argv: string[];
  /** The sandbox image that carries it.
   *
   *  Load-bearing, not documentation. A `.py` file can be opened in a Node
   *  project, and asking that container for `pylsp` gets "executable file not
   *  found" halfway through a WebSocket handshake -- a failure with no reason
   *  attached, arriving at a client that has already been told the server was
   *  starting. Checked up front instead, and refused with a sentence.
   */
  image: string;
}

/** Language servers this platform knows how to start, by Monaco language id. */
export const LANGUAGE_SERVERS: Record<string, LanguageServer> = {
  // Python first: the sandbox image already carries a toolchain that knows all
  // of this and was never asked.
  python: {
    argv: ["pylsp"],
    image: "sandbox-python:latest",
  },
  // Go second, and cheap: one registry entry and a `go install` in the image
  // that already ships the compiler. Everything underneath -- the gateway, the
  // Content-Length framing, lazy start, idle stop, the memory refusal -- was
  // built for the first one and is language-agnostic.
  go: {
    argv: ["gopls", "serve"],
    image: "sandbox-go:latest",
  },
};

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
 *  §3.3 asks for the memory policy to be in place from the first commit
 *  rather than added after the first OOM, and this is it. The refusal
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

  if (server && projectImage !== undefined && projectImage !== server.image) {
    return {
      allowed: false,
      code: "WRONG_IMAGE",
      // Named both ways round, because the fix is the user's to choose: they
      // can open the file in a project of that language, or not expect
      // intelligence for a file that is a passenger in this one.
      message:
        `${language} intelligence needs a ${server.image} container; this ` +
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
