import { env } from "../config/env.js";

/** Whether a notebook kernel may be started, and if not, why. plan.md §12.3.
 *
 *  Deliberately the same shape as `lspPolicy.ts`, and for the same reason
 *  that file gives: the refusal has to carry a message, because the
 *  alternative — starting a kernel and letting the dev server be killed for
 *  memory — is a failure the user cannot diagnose and did not cause.
 *
 *  It is a separate file rather than a branch inside `lspPolicy` because the
 *  two answers differ on every input. A language server is a nice-to-have
 *  that idles; a kernel is the *only* way to run the document that is open,
 *  and it holds whatever the user's dataframe weighs for as long as the tab
 *  is open.
 */

export interface KernelSpec {
  /** What to exec inside the container. Baked into the image; see
   *  `images/python/Dockerfile`. */
  argv: string[];
  /** The sandbox image that carries it.
   *
   *  Load-bearing exactly as it is for a language server: a `.ipynb` can be
   *  opened in a Node project, and asking that container for `rc-kernel` gets
   *  "executable file not found" halfway through a WebSocket handshake — a
   *  failure with no reason attached, arriving at a client that has already
   *  drawn a "starting the kernel" spinner. */
  image: string;
  /** Monaco's language id for the code cells, so the cell editors highlight. */
  language: string;
}

/** Kernels this platform knows how to start, by notebook language.
 *
 *  One entry, and that is the honest state of it. §12.3 says this row is
 *  "worth doing only if you write Python", and a registry with a single row
 *  is what that sentence looks like in code — the shape is there for a second
 *  kernel, and nothing pretends a second one exists.
 */
export const KERNELS: Record<string, KernelSpec> = {
  python: {
    argv: ["rc-kernel"],
    image: "sandbox-python:latest",
    language: "python",
  },
};

/** The kernel a notebook's own metadata asks for, reduced to one this has.
 *
 *  A notebook records its kernel in `metadata.kernelspec.language`, and every
 *  Python notebook in the world says `python` there. Anything else — R,
 *  Julia, a Deno kernel — resolves to nothing rather than being run by Python
 *  and failing on line one with a syntax error, which is what "just use the
 *  only kernel we have" would produce.
 */
export function kernelForLanguage(language: string | undefined): string | null {
  const normalised = (language ?? "python").toLowerCase();
  return normalised in KERNELS ? normalised : null;
}

export type KernelRefusal =
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

export function canStartKernel(
  language: string,
  /** The image the project's container actually runs. Optional so a caller
   *  that has not resolved the template yet can still ask the cheap
   *  questions; when it is known, the check is made. */
  projectImage?: string,
): KernelRefusal {
  if (!env.NOTEBOOKS_ENABLED) {
    return {
      allowed: false,
      code: "DISABLED",
      message: "Notebook kernels are not enabled on this deployment.",
    };
  }

  const kernel = KERNELS[language];
  if (!kernel) {
    return {
      allowed: false,
      code: "UNSUPPORTED_LANGUAGE",
      // Named, so the message is about their notebook rather than about this
      // platform's registry.
      message:
        `This notebook asks for a ${language} kernel, and this platform only ` +
        `runs Python. The file opens and edits either way; only Run does not.`,
    };
  }

  if (projectImage !== undefined && projectImage !== kernel.image) {
    return {
      allowed: false,
      code: "WRONG_IMAGE",
      // Both ways round, because the fix is the user's to choose.
      message:
        `Running a notebook needs a ${kernel.image} container; this project ` +
        `runs ${projectImage}. Open the notebook in a Python project to run ` +
        `it.`,
    };
  }

  if (env.CONTAINER_MEMORY_MB < env.KERNEL_MIN_CONTAINER_MEMORY_MB) {
    return {
      allowed: false,
      code: "NOT_ENOUGH_MEMORY",
      message:
        `A notebook kernel needs a container memory limit of at least ` +
        `${String(env.KERNEL_MIN_CONTAINER_MEMORY_MB)} MB; this deployment ` +
        `allows ${String(env.CONTAINER_MEMORY_MB)} MB. Starting one here ` +
        `would risk the dev server being killed for memory instead.`,
    };
  }

  return { allowed: true };
}
