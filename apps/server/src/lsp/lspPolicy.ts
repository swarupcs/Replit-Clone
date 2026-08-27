import { env } from "../config/env.js";

/** Language servers this platform knows how to start, by Monaco language id. */
export const LANGUAGE_SERVERS: Record<string, { argv: string[]; image: string }> = {
  // Python first, which is §3.3's "smallest honest first step": the sandbox
  // image already carries a toolchain that knows all of this and is never
  // asked.
  python: {
    argv: ["pylsp"],
    image: "sandbox-python:latest",
  },
};

export type LspRefusal =
  | { allowed: true }
  | {
      allowed: false;
      code: "DISABLED" | "UNSUPPORTED_LANGUAGE" | "NOT_ENOUGH_MEMORY";
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
export function canStartLanguageServer(language: string): LspRefusal {
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
