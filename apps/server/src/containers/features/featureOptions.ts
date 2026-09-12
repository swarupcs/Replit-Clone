import { FeatureError } from "./featureRef.js";

/** Turning a Feature's options into the environment its install script reads.
 *  plan.md §11.10.
 *
 *  The spec's rule is short and exact: each option becomes an environment
 *  variable named by uppercasing the option's key, and an option the user did
 *  not set takes the `default` from the Feature's own
 *  `devcontainer-feature.json`. Booleans are `true`/`false`, numbers are
 *  decimal, and an `enum` option must be one of its listed values.
 *
 *  **Why this validates rather than passes through.** These values are
 *  interpolated into a shell environment for a script that runs as root. The
 *  script is the Feature author's, but the values are the project's — and a
 *  project's `devcontainer.json` is a file in a repository this platform did
 *  not write. An option value with a newline in it is two environment
 *  entries; one with a null byte is a truncated one.
 */

/** One option as the Feature declares it. */
export interface FeatureOption {
  type?: "string" | "boolean";
  default?: string | boolean;
  enum?: string[];
  proposals?: string[];
}

export interface FeatureMetadata {
  id?: string;
  options?: Record<string, FeatureOption>;
  /** Features this one must be installed after. */
  installsAfter?: string[];
  /** Variables the Feature wants in the final image. Honoured, because the
   *  whole point of installing a language is that it is on the PATH. */
  containerEnv?: Record<string, string>;
}

const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_VALUE = 1024;

function assertSafe(name: string, value: string): void {
  if (value.length > MAX_VALUE) {
    throw new FeatureError(`The value for "${name}" is too long`);
  }
  // A newline is a second environment entry; a null byte truncates the first.
  if (/[\r\n\0]/.test(value)) {
    throw new FeatureError(`The value for "${name}" cannot contain a newline`);
  }
}

/** The environment an install script should see.
 *
 *  Declared options only. An option the Feature does not declare is dropped
 *  rather than passed on: the Feature cannot read it, so passing it would be
 *  writing into that script's environment on the say-so of a file in the
 *  repository, for a name the Feature author never reserved.
 */
export function featureEnv(
  metadata: FeatureMetadata,
  requested: Record<string, unknown>,
): Record<string, string> {
  const declared = metadata.options ?? {};
  const env: Record<string, string> = {};

  for (const [key, option] of Object.entries(declared)) {
    if (!NAME.test(key)) {
      throw new FeatureError(`"${key}" is not a usable option name`);
    }

    const given = requested[key];
    const value = given === undefined ? option.default : given;
    if (value === undefined) continue;

    let rendered: string;
    if (typeof value === "boolean") {
      rendered = value ? "true" : "false";
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new FeatureError(`The value for "${key}" is not a number`);
      }
      rendered = String(value);
    } else if (typeof value === "string") {
      rendered = value;
    } else {
      throw new FeatureError(`The value for "${key}" must be text or true/false`);
    }

    assertSafe(key, rendered);

    // `enum` is a closed set and the spec says so. `proposals` deliberately is
    // not: it is a hint to an editor's autocomplete, and refusing a value not
    // in it would break every Feature that uses proposals the way they are
    // meant to be used.
    if (option.enum && !option.enum.includes(rendered)) {
      throw new FeatureError(
        `"${rendered}" is not one of the values "${key}" accepts`,
      );
    }

    env[key.toUpperCase()] = rendered;
  }

  // Named rather than ignored. A typo in an option name otherwise produces a
  // Feature that installs with its defaults, which looks like it worked.
  const unknown = Object.keys(requested).filter((key) => !(key in declared));
  if (unknown.length > 0) {
    throw new FeatureError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not an option" : "are not options"} this feature accepts`,
    );
  }

  return env;
}

/** What the user asked for, from the `features` block.
 *
 *  The spec allows `"feature": {}` and, historically, `"feature": "version"`
 *  as shorthand for `{ version: "…" }`. Both are accepted; anything else is
 *  refused by name.
 */
export function requestedOptions(value: unknown, id: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") return { version: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new FeatureError(`The options for "${id}" must be an object`);
}
