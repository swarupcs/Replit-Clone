/** Whether this deployment's origins and cookie policy can actually work.
 *
 *  plan.md §11.5. Every failure this file describes is silent. Not "silent"
 *  in the sense of hard to debug — silent in the sense that nothing anywhere
 *  reports an error: the browser drops a `Set-Cookie` it dislikes without
 *  telling the page, the server never learns the cookie was discarded, and the
 *  symptom arrives minutes later as "sign-in does nothing" or "every preview
 *  says no preview session". A log line at boot is worth more than any amount
 *  of documentation, because the person who gets this wrong is by definition
 *  the person who did not read the paragraph about it.
 *
 *  **Why the app has an opinion at all.** Locally the three origins differ
 *  only by PORT, and cookies ignore ports — `localhost:3000` and
 *  `localhost:3101` share a cookie jar, so the preview cookie the API sets
 *  arrives at the preview listener for free. Put a reverse proxy in front and
 *  the same three concerns become three HOSTNAMES, at which point that cookie
 *  is host-only to the API's name and is never sent to the preview's. Nothing
 *  in the codebase changed; the deployment did, and previews stop working.
 *  COOKIE_DOMAIN is the answer, and these checks are what stop it being set
 *  wrongly — a Domain the browser rejects fails exactly as quietly.
 *
 *  Pure and given its inputs, so the whole matrix can be tested without an
 *  environment. `errors` refuse the boot; `warnings` do not, because they
 *  describe a deployment that works but is likely not the one intended.
 */

export interface ExposureConfig {
  /** Where the editor is served. CORS and the preview CSP name it. */
  webOrigin: string;
  /** This server's own public origin. */
  apiOrigin: string;
  /** Where previews are served, always resolved: PREVIEW_ORIGIN when it is
   *  set, and otherwise the API's own scheme and host on PREVIEW_PORT, which
   *  is what the browser actually reaches locally. */
  previewOrigin: string;
  /** Whether that came from PREVIEW_ORIGIN or was derived from the port. Only
   *  a declared one can name a host a reverse proxy is serving. */
  previewOriginDeclared: boolean;
  /** The origin published sites hang off, without their subdomain. */
  deployOrigin: string;
  deploymentsEnabled: boolean;
  /** The `Domain` put on the preview cookie, or "" to leave it host-only. */
  cookieDomain: string;
  cookieSameSite: "lax" | "none";
  cookieSecure: boolean;
  trustedProxyHops: number;
}

export interface ExposureReport {
  errors: string[];
  warnings: string[];
}

/** Hosts a browser treats as secure over plain HTTP, so a Secure cookie set on
 *  one is kept rather than discarded. Loopback only — this is the same list
 *  every browser implements, and `localhost` is on it by name. */
function isTrustworthyPlainHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
}

/** Whether a cookie with `Domain=domain` would be sent to `host`.
 *
 *  The rule browsers actually apply: the domain must equal the host or be a
 *  dot-separated suffix of it. A leading dot in the attribute is legal and
 *  ignored, so it is stripped rather than refused. */
function domainCovers(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function hostOf(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

function isHttps(origin: string): boolean {
  return new URL(origin).protocol === "https:";
}

/** Reads the three origins, the cookie policy and the proxy setting together,
 *  and says which combinations cannot work. */
export function checkExposure(config: ExposureConfig): ExposureReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const web = hostOf(config.webOrigin);
  const api = hostOf(config.apiOrigin);
  const preview = hostOf(config.previewOrigin);
  const deploy = hostOf(config.deployOrigin);
  const domain = config.cookieDomain.replace(/^\./, "").toLowerCase();

  /* ---- the cookie policy on its own ------------------------------------ */

  // A browser discards a SameSite=None cookie that is not also Secure, and
  // says nothing. Sign-in then appears to succeed and the session is gone on
  // the next request.
  if (config.cookieSameSite === "none" && !config.cookieSecure) {
    errors.push(
      'COOKIE_SAME_SITE="none" requires COOKIE_SECURE=true. Browsers discard ' +
        "a SameSite=None cookie that is not Secure, without an error, so " +
        "sign-in would appear to work and every later request would be " +
        "unauthenticated.",
    );
  }

  // The mirror image: Secure cookies are dropped over plain HTTP everywhere
  // except loopback, which browsers exempt by name.
  for (const [name, origin] of [
    ["WEB_ORIGIN", config.webOrigin],
    ["API_ORIGIN", config.apiOrigin],
  ] as const) {
    if (
      config.cookieSecure &&
      !isHttps(origin) &&
      !isTrustworthyPlainHost(hostOf(origin))
    ) {
      errors.push(
        `COOKIE_SECURE=true with a plain-HTTP ${name} (${origin}). The ` +
          "browser will discard every cookie this server sets. Either " +
          "terminate TLS in front of it or set COOKIE_SECURE=false.",
      );
    }
  }

  /* ---- the three origins against each other ---------------------------- */

  // Both already argued in config/env.ts, where they are stated as facts about
  // ports. They are just as true about hostnames, and a reverse proxy is the
  // first thing that makes them possible to get wrong.
  // Compared as ORIGINS rather than hosts, because that is the boundary the
  // browser enforces for script access: localhost:3101 and localhost:15273
  // are the same host and are correctly two origins. The cookie checks below
  // compare hosts, because cookies ignore ports — the two halves of this file
  // use two different comparisons on purpose.
  const sameOrigin = (a: string, b: string): boolean =>
    new URL(a).origin === new URL(b).origin;

  if (config.deploymentsEnabled && sameOrigin(config.deployOrigin, config.webOrigin)) {
    errors.push(
      `DEPLOY_ORIGIN and WEB_ORIGIN are the same origin (${config.webOrigin}). ` +
        "A published site is arbitrary code and would run same-origin with " +
        "the editor.",
    );
  }

  if (
    config.deploymentsEnabled &&
    sameOrigin(config.deployOrigin, config.previewOrigin)
  ) {
    errors.push(
      `DEPLOY_ORIGIN and the preview origin are the same origin ` +
        `(${config.deployOrigin}). A published site is public and a preview ` +
        "is authenticated by a cookie on that origin.",
    );
  }

  if (sameOrigin(config.previewOrigin, config.webOrigin)) {
    errors.push(
      `The preview origin and WEB_ORIGIN are the same origin ` +
        `(${config.webOrigin}). A project's own code would run same-origin ` +
        "with the editor.",
    );
  }

  /* ---- the one that a reverse proxy introduces ------------------------- */

  // The headline failure of §11.5, and the reason this file exists. Two
  // different names means a host-only cookie set on one never reaches the
  // other, so previewGuard answers "No preview session" for every request and
  // the editor shows an empty pane with nothing in any log to explain it.
  if (preview !== api && domain === "") {
    errors.push(
      `Previews are served from ${preview} and the API from ${api}, but ` +
        "COOKIE_DOMAIN is unset. The preview cookie would be host-only to " +
        "the API's name and never sent to the preview's, so every preview " +
        "would be refused. Set COOKIE_DOMAIN to the domain both share.",
    );
  }

  /* ---- and the ways COOKIE_DOMAIN itself fails silently ---------------- */

  if (domain !== "") {
    // A Domain attribute on an IP address, or on a single-label name, is
    // rejected outright — which puts the deployment back in the case above
    // while looking configured.
    if (isIpLiteral(domain)) {
      errors.push(
        `COOKIE_DOMAIN=${domain} is an IP address. Browsers reject a Domain ` +
          "attribute on an IP, so the cookie would be discarded. Use a name, " +
          "or put every origin on one host and leave this unset.",
      );
    } else if (!domain.includes(".")) {
      errors.push(
        `COOKIE_DOMAIN=${domain} has no dot in it. Browsers reject a Domain ` +
          "attribute that is a single label, so the cookie would be " +
          "discarded.",
      );
    }

    // A Domain the browser will not match against the setting host is
    // rejected in the same silent way.
    if (!domainCovers(domain, api)) {
      errors.push(
        `COOKIE_DOMAIN=${domain} does not cover API_ORIGIN's host (${api}). ` +
          "A browser rejects a Set-Cookie whose Domain is not a suffix of " +
          "the host that sent it.",
      );
    }

    if (!domainCovers(domain, preview)) {
      errors.push(
        `COOKIE_DOMAIN=${domain} does not cover the preview origin's host ` +
          `(${preview}), which is the one host it exists to reach. Every ` +
          "preview would be refused.",
      );
    }

    if (!domainCovers(domain, web)) {
      warnings.push(
        `COOKIE_DOMAIN=${domain} does not cover WEB_ORIGIN's host (${web}). ` +
          "That is workable — the editor authenticates with a bearer token " +
          "and the refresh cookie is host-only to the API either way — but " +
          "it usually means the domain is narrower than intended.",
      );
    }

    // The trade this setting makes, stated as a refusal rather than a note.
    // Widening the preview cookie to a shared parent domain sends it to every
    // sibling name under that parent, and a published site is somebody's code
    // running behind a name this platform hands out. Same argument env.ts
    // already makes for keeping the deploy origin off the preview one; it
    // simply had no way to be violated until a Domain attribute existed.
    if (config.deploymentsEnabled && domainCovers(domain, deploy)) {
      errors.push(
        `COOKIE_DOMAIN=${domain} covers DEPLOY_ORIGIN's host (${deploy}). ` +
          "Published sites are arbitrary user code, and a cookie scoped to " +
          "the shared parent is sent to them and can be overwritten by them. " +
          "Put published sites on a different domain, or set DEPLOY_PORT=0.",
      );
    }
  }

  /* ---- warnings: works, but is probably not what was meant ------------- */

  if (isHttps(config.webOrigin) !== isHttps(config.apiOrigin)) {
    warnings.push(
      `WEB_ORIGIN (${config.webOrigin}) and API_ORIGIN (${config.apiOrigin}) ` +
        "do not use the same scheme. A page served over HTTPS cannot call an " +
        "HTTP API at all, and the reverse loses the Secure cookies.",
    );
  }

  // Nothing can prove a proxy is there at boot, but HTTPS origins with zero
  // trusted hops is the shape of somebody who put one in front and did not
  // come back to this setting. Rate limits then key on the proxy's own
  // address, so one account's failed logins throttle everybody.
  if (isHttps(config.apiOrigin) && config.trustedProxyHops === 0) {
    warnings.push(
      "API_ORIGIN is HTTPS but TRUSTED_PROXY_HOPS=0. This server terminates " +
        "no TLS itself, so something is almost certainly in front of it — " +
        "and with no trusted hops every rate limit keys on that proxy's " +
        "address rather than the client's.",
    );
  }

  if (isHttps(config.apiOrigin) && !config.previewOriginDeclared) {
    warnings.push(
      "PREVIEW_ORIGIN is unset on an HTTPS deployment. Previews are being " +
        "served on a port of their own, which a reverse proxy will not be " +
        "publishing; set it to the name previews are reachable at so this " +
        "check can see the whole picture.",
    );
  }

  return { errors, warnings };
}
