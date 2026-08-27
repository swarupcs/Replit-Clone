import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../config/env.js";

/** Why a connection string was refused. Distinct codes because the operator
 *  fix differs: a private address is a policy call, a malformed string is a
 *  typo, and the platform's own database is never allowed at all. */
export type RefusalCode =
  | "MALFORMED"
  | "UNSUPPORTED_SCHEME"
  | "PRIVATE_ADDRESS"
  | "PLATFORM_DATABASE"
  | "UNRESOLVABLE";

export class ConnectionRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionRefused";
  }
}

/** A checked connection, with the address the check actually approved.
 *
 *  The resolved address is returned rather than discarded so the caller can
 *  connect to *it* rather than re-resolving the hostname. That is the whole
 *  defence against DNS rebinding: a name that answers with a public address
 *  when asked and a loopback address a moment later defeats any check that
 *  validates a name and then hands the name to a socket.
 */
export interface CheckedConnection {
  /** The original string, for storing sealed. Never logged. */
  url: string;
  scheme: "postgresql" | "mongodb";
  host: string;
  port: number;
  /** The address the guard resolved and approved. Connect to this. */
  address: string;
}

const POSTGRES_SCHEMES = new Set(["postgres:", "postgresql:"]);
const MONGO_SCHEMES = new Set(["mongodb:", "mongodb+srv:"]);

const DEFAULT_PORTS: Record<string, number> = {
  "postgres:": 5432,
  "postgresql:": 5432,
  "mongodb:": 27017,
  "mongodb+srv:": 27017,
};

/** Everything a server must not be talked into dialling on someone's behalf.
 *
 *  169.254.0.0/16 earns its place twice over: it is link-local, and it is
 *  where every major cloud puts its instance metadata endpoint, which hands
 *  out credentials to anything that can make an HTTP request from the host.
 */
function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;

  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 carrier NAT
  if (a >= 224) return true; // multicast and reserved

  return false;
}

function isPrivateV6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";

  if (value === "::1" || value === "::") return true;
  // Unique-local and link-local.
  if (/^f[cd]/.test(value)) return true;
  if (value.startsWith("fe80")) return true;

  // IPv4-mapped (::ffff:127.0.0.1) is the standard way to smuggle a v4
  // loopback past a check that only looks at v6 prefixes.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);

  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  // Not an IP at all: refuse rather than guess.
  return true;
}

/** The platform's own database, by host and port.
 *
 *  A second line that does not depend on the range check being complete.
 *  §7.2 asks for it by value precisely because "we blocked the private
 *  ranges" is the kind of claim that is true until the deployment moves the
 *  database somewhere public.
 */
function isPlatformDatabase(host: string, port: number): boolean {
  try {
    const own = new URL(env.DATABASE_URL);
    const ownPort = Number(own.port) || 5432;
    return own.hostname.toLowerCase() === host.toLowerCase() && ownPort === port;
  } catch {
    // An unparseable DATABASE_URL is the deployment's problem, not this
    // request's — but failing open here would be the worst possible choice,
    // so an unknown own-address means nothing external is allowed.
    return true;
  }
}

/** Removes anything secret from a string before it reaches a log or a user.
 *
 *  Mirrors `gitService.redactToken`: an error message quoting the string that
 *  caused it is the most natural thing in the world to write and the easiest
 *  way to put a password in a log file.
 */
export function redactConnectionString(value: string): string {
  return value.replace(/:\/\/[^@/]*@/g, "://***@");
}

/** Checks a user-supplied connection string before anything dials it.
 *
 *  §7.2 is blunt about why: the query runs on the server, so the string is a
 *  host the *server* dials, from inside the deployment's network, with the
 *  deployment's reachability. Pointed at the platform's own Postgres it is a
 *  shell on every user row, password hash and encrypted GitHub token.
 */
export async function checkConnectionString(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): Promise<CheckedConnection> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ConnectionRefused("MALFORMED", "That is not a valid connection string.");
  }

  const scheme = parsed.protocol.toLowerCase();
  const isPostgres = POSTGRES_SCHEMES.has(scheme);
  const isMongo = MONGO_SCHEMES.has(scheme);
  if (!isPostgres && !isMongo) {
    throw new ConnectionRefused(
      "UNSUPPORTED_SCHEME",
      "Only postgresql:// and mongodb:// connection strings are supported.",
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new ConnectionRefused("MALFORMED", "That connection string names no host.");
  }

  const port = Number(parsed.port) || DEFAULT_PORTS[scheme] || 0;

  if (isPlatformDatabase(host, port)) {
    throw new ConnectionRefused(
      "PLATFORM_DATABASE",
      "That address is not available.",
    );
  }

  // A literal address needs no lookup, and passing one through DNS would
  // only give the resolver a chance to say something different.
  let address: string;
  if (isIP(host)) {
    address = host;
  } else {
    try {
      address = (await lookup(host)).address;
    } catch {
      throw new ConnectionRefused(
        "UNRESOLVABLE",
        "That host could not be resolved.",
      );
    }
  }

  // Re-checked against the *resolved* address before the range check, not
  // after: a hostname that resolves onto the platform's own database is the
  // platform's own database, and saying so is more use than "that is on a
  // private network" — which would also be true, and less specific. Both
  // refuse, so the ordering is about the message rather than the outcome.
  if (isPlatformDatabase(address, port)) {
    throw new ConnectionRefused("PLATFORM_DATABASE", "That address is not available.");
  }

  if (!options.allowPrivate && isPrivateAddress(address)) {
    throw new ConnectionRefused(
      "PRIVATE_ADDRESS",
      "That address is on a private network and cannot be reached from here.",
    );
  }

  return {
    url: raw.trim(),
    scheme: isPostgres ? "postgresql" : "mongodb",
    host,
    port,
    address,
  };
}
