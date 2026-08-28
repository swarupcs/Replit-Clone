import { lookup, resolveSrv } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "@replit-clone/shared";
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

/** Re-exported so callers here keep one import, and so the shared definition
 *  is the only one. It moved to `@replit-clone/shared` when the egress gateway
 *  needed the same rule from a different process — see `shared/src/network.ts`
 *  for why the two must not each keep a copy.
 */
export { isPrivateAddress };

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

/* ------------------------------------------------------------------ *
 *  MongoDB
 * ------------------------------------------------------------------ */

/** One host a Mongo client would dial, with the address the guard approved. */
export interface MongoHost {
  host: string;
  port: number;
  address: string;
}

/** A checked Mongo connection.
 *
 *  A list rather than a single host because a Mongo URL names a replica set
 *  seed list, and `new URL` cannot parse one at all — `mongodb://a:1,b:2/db`
 *  throws. Every host in the list is checked; one private member is enough to
 *  refuse the whole string, because the driver will happily use it.
 */
export interface CheckedMongoConnection {
  url: string;
  scheme: "mongodb";
  /** True for `mongodb+srv://`, where the hosts came from an SRV lookup. */
  srv: boolean;
  hosts: MongoHost[];
  /** What to show a user: the seed list without credentials. */
  label: string;
}

const SRV_DEFAULT_PORT = 27017;

/** Resolves a host and refuses it if the address is one we must not dial.
 *
 *  Split out of `checkConnectionString` so the Postgres and Mongo paths share
 *  one definition of "not allowed" — two copies would drift, and the copy
 *  that drifts is the one with the hole.
 */
async function resolveAndCheck(
  host: string,
  port: number,
  allowPrivate: boolean,
): Promise<string> {
  if (isPlatformDatabase(host, port)) {
    throw new ConnectionRefused("PLATFORM_DATABASE", "That address is not available.");
  }

  let address: string;
  if (isIP(host)) {
    address = host;
  } else {
    try {
      address = (await lookup(host)).address;
    } catch {
      throw new ConnectionRefused("UNRESOLVABLE", "That host could not be resolved.");
    }
  }

  if (isPlatformDatabase(address, port)) {
    throw new ConnectionRefused("PLATFORM_DATABASE", "That address is not available.");
  }

  if (!allowPrivate && isPrivateAddress(address)) {
    throw new ConnectionRefused(
      "PRIVATE_ADDRESS",
      "That address is on a private network and cannot be reached from here.",
    );
  }

  return address;
}

/** Splits a Mongo connection string into its scheme, seed list and the rest.
 *
 *  Hand-rolled rather than `new URL` because the authority is comma-separated
 *  and `new URL` rejects it outright. Credentials are split on the *last* `@`:
 *  a password may legally contain one when percent-encoded badly, and taking
 *  the first `@` would read part of the password as a hostname.
 */
export function parseMongoAuthority(raw: string): {
  scheme: "mongodb:" | "mongodb+srv:";
  hosts: { host: string; port: number }[];
} {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf("://");
  if (separator < 0) {
    throw new ConnectionRefused("MALFORMED", "That is not a valid connection string.");
  }

  const scheme = `${trimmed.slice(0, separator).toLowerCase()}:`;
  if (scheme !== "mongodb:" && scheme !== "mongodb+srv:") {
    throw new ConnectionRefused(
      "UNSUPPORTED_SCHEME",
      "Only postgresql:// and mongodb:// connection strings are supported.",
    );
  }

  const afterScheme = trimmed.slice(separator + 3);
  const end = afterScheme.search(/[/?]/);
  const authority = end < 0 ? afterScheme : afterScheme.slice(0, end);

  const at = authority.lastIndexOf("@");
  const seedList = at < 0 ? authority : authority.slice(at + 1);
  if (!seedList) {
    throw new ConnectionRefused("MALFORMED", "That connection string names no host.");
  }

  const hosts = seedList.split(",").map((entry) => {
    const value = entry.trim();
    if (!value) {
      throw new ConnectionRefused("MALFORMED", "That connection string names no host.");
    }

    // Bracketed IPv6, `[::1]:27017`, before the general colon split — an
    // unbracketed v6 address is all colons and would parse as nonsense.
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracketed) {
      return {
        host: bracketed[1] ?? "",
        port: Number(bracketed[2]) || SRV_DEFAULT_PORT,
      };
    }

    const colon = value.lastIndexOf(":");
    if (colon < 0) return { host: value, port: SRV_DEFAULT_PORT };

    const port = Number(value.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ConnectionRefused("MALFORMED", "That connection string names no host.");
    }
    return { host: value.slice(0, colon), port };
  });

  if (scheme === "mongodb+srv:" && hosts.length !== 1) {
    throw new ConnectionRefused(
      "MALFORMED",
      "A mongodb+srv:// string names exactly one host.",
    );
  }

  return { scheme, hosts };
}

/** Checks a Mongo connection string before anything dials it.
 *
 *  The same job as `checkConnectionString`, with two differences the protocol
 *  forces:
 *
 *  1. **A seed list.** Every host is checked, not just the first. A replica
 *     set with one member on loopback is reachable through that member.
 *  2. **SRV.** `mongodb+srv://` hostnames usually have no A record at all —
 *     the real hosts come from `_mongodb._tcp.<host>`. Checking the SRV name
 *     itself would refuse every Atlas cluster, so the SRV record is resolved
 *     here and its targets are what get checked.
 *
 *  Unlike the Postgres path this does **not** pin an address for the driver
 *  to dial. It cannot: Mongo connections are TLS by default and Atlas
 *  certificates are issued for the hostname, so handing the driver an IP
 *  fails hostname verification. Address pinning and TLS verification are
 *  mutually exclusive here, and dropping TLS to gain pinning would be a worse
 *  trade. The residual gap is a rebind between this check and the driver's
 *  own lookup, which needs the attacker to control DNS for the domain; see
 *  §10.4 for the decision and what would make it worth revisiting.
 */
export async function checkMongoConnectionString(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): Promise<CheckedMongoConnection> {
  const { scheme, hosts: seeds } = parseMongoAuthority(raw);
  const allowPrivate = options.allowPrivate ?? false;

  let targets = seeds;
  const srv = scheme === "mongodb+srv:";

  if (srv) {
    const seed = seeds[0];
    if (!seed) {
      throw new ConnectionRefused("MALFORMED", "That connection string names no host.");
    }
    let records: { name: string; port: number }[];
    try {
      records = await resolveSrv(`_mongodb._tcp.${seed.host}`);
    } catch {
      throw new ConnectionRefused("UNRESOLVABLE", "That host could not be resolved.");
    }
    if (records.length === 0) {
      throw new ConnectionRefused("UNRESOLVABLE", "That host could not be resolved.");
    }
    targets = records.map((record) => ({ host: record.name, port: record.port }));
  }

  const checked: MongoHost[] = [];
  for (const target of targets) {
    checked.push({
      host: target.host,
      port: target.port,
      address: await resolveAndCheck(target.host, target.port, allowPrivate),
    });
  }

  return {
    url: raw.trim(),
    scheme: "mongodb",
    srv,
    hosts: checked,
    label: seeds.map((seed) => `${seed.host}:${seed.port}`).join(","),
  };
}
