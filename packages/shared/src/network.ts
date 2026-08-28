/** Which addresses nothing on this platform may be talked into reaching.
 *
 *  Lives in `shared` because two very different things need the SAME answer,
 *  and a second copy is how one of them ends up with a hole:
 *
 *  1. The server, checking a user-supplied database connection string before
 *     it dials it (`lib/connectionGuard.ts`). There the risk is SSRF — the
 *     query runs on the server, so the string names a host the *server*
 *     reaches, with the deployment's reachability.
 *  2. The egress gateway, checking where a sandbox container is asking to
 *     connect (`images/egress/proxy.mjs`). There the risk is a project's own
 *     code — or, far more likely, something it installed — reaching the
 *     platform's internals from inside the network.
 *
 *  The two enforce it at different layers and for different reasons, but
 *  "private" means one thing, and it is defined here.
 */

/** Everything a service must not be talked into dialling on someone's behalf.
 *
 *  169.254.0.0/16 earns its place twice over: it is link-local, and it is
 *  where every major cloud puts its instance metadata endpoint, which hands
 *  out credentials to anything able to make an HTTP request from the host.
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

/** Whether an address literal is one nothing here may connect to.
 *
 *  Takes an ADDRESS, never a hostname: a name is not a destination until it
 *  has been resolved, and checking the name rather than what it resolved to
 *  is what DNS rebinding exists to exploit. Anything that is not a valid IP
 *  is refused rather than guessed at.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim();

  // `node:net`'s isIP is not available to every consumer of this package, and
  // the shapes are simple enough to recognise directly. A string with a colon
  // is v6, with a dot is v4; anything else is not an address.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return isPrivateV4(value);
  if (value.includes(":")) return isPrivateV6(value);

  // Not an IP at all: refuse rather than guess.
  return true;
}

/* ------------------------------------------------------------------ *
 *  Sandbox egress
 * ------------------------------------------------------------------ */

/** Why the gateway refused, or that it did not. */
export type EgressVerdict =
  | { allowed: true; address: string }
  | { allowed: false; reason: string };

/** What the gateway is configured to permit. */
export interface EgressPolicy {
  /** Domain suffixes a sandbox may reach. Empty means any public address. */
  allowDomains: string[];
  /** Ports a sandbox may reach, whatever the destination. */
  allowPorts: number[];
}

/** Whether a hostname is covered by an allowlist of domain suffixes.
 *
 *  Matches the name itself or anything under it, and matches on a LABEL
 *  boundary: "evil-github.com" must not pass an allowlist naming
 *  "github.com", which a plain `endsWith` would let through.
 */
export function domainAllowed(host: string, allowDomains: string[]): boolean {
  if (allowDomains.length === 0) return true;

  const name = host.toLowerCase().replace(/\.$/, "");
  return allowDomains.some((entry) => {
    const suffix = entry.toLowerCase().replace(/^\.|\.$/g, "");
    return name === suffix || name.endsWith(`.${suffix}`);
  });
}

/** The whole egress decision, given a destination and what it resolved to.
 *
 *  Pure, and separate from the socket work in `images/egress/proxy.mjs`, for
 *  the same reason the address rule is shared at all: this is the security
 *  decision, and a security decision that can only be exercised by standing
 *  up a container and a network is a security decision nobody tests.
 *
 *  `addresses` is every address the name resolved to, not the first one. A
 *  name answering with one public address and one loopback address is not a
 *  half-safe destination; it is an attack with a fallback. The approved
 *  address is returned so the caller dials IT rather than re-resolving the
 *  name — re-resolving is what DNS rebinding exploits.
 */
export function egressDecision(
  host: string,
  port: number,
  addresses: string[],
  policy: EgressPolicy,
): EgressVerdict {
  if (!policy.allowPorts.includes(port)) {
    return { allowed: false, reason: `port ${String(port)} is not permitted` };
  }

  if (!domainAllowed(host, policy.allowDomains)) {
    return {
      allowed: false,
      reason: `${host} is not on this server's allowlist`,
    };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `${host} could not be resolved` };
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return {
        allowed: false,
        reason: `${host} resolves to a private address, which a sandbox may not reach`,
      };
    }
  }

  // Non-null: the empty case returned above.
  return { allowed: true, address: addresses[0] as string };
}
