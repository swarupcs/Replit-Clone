import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { resolveCustomDomain } from "../../service/customDomainService.js";
import { increment } from "../../lib/metrics.js";

/** Telling a TLS terminator which hostnames this platform will serve.
 *
 *  §3.3 carried "certificates for custom domains" as blocked infrastructure,
 *  and the decision that unblocks most of it is a **refusal to write an ACME
 *  client**. An account key, a challenge responder, a renewal timer and a
 *  certificate store are four things to get right, all of them solved, and the
 *  solution is a reverse proxy this deployment runs anyway.
 *
 *  Caddy asks an HTTP endpoint before it will issue for a hostname it has not
 *  seen — `on_demand_tls { ask ... }`. That question is one this codebase can
 *  already answer: `resolveCustomDomain` exists, and a domain is in it only
 *  after its owner published a TXT record that was checked (§2.12). So the
 *  whole of the code half is a status code in front of a function that was
 *  already written, and what stays blocked in §3.3 is a config file and where
 *  a key lives — which is genuinely the operator's.
 *
 *      # Caddyfile
 *      {
 *          on_demand_tls {
 *              ask http://server:3000/api/v1/tls/authorize
 *          }
 *      }
 *      https:// {
 *          tls { on_demand }
 *          reverse_proxy server:3000
 *      }
 *
 *  Three things this has to get right, because it is the only guard between a
 *  public listener and unbounded certificate issuance.
 */

/** Every yes is an ACME order somewhere, and a certificate authority's rate
 *  limits are the kind you discover by being locked out for a week. Generous
 *  enough for a proxy restarting and re-asking about every domain it serves;
 *  nothing like enough to walk a dictionary through it. */
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // No body on this route in any case: the proxy reads the status.
  message: "",
});

const router = express.Router();

/** Answers only with a status code, and deliberately.
 *
 *  This route is unauthenticated because it has to be — the proxy asks before
 *  any session exists — which makes it a hostname oracle if it says anything
 *  else. 404 covers "never heard of it", "claimed but never verified" and
 *  "verified and then the record went away" alike, because distinguishing them
 *  would tell an anonymous caller which domains somebody has claimed here.
 */
router.get(
  "/authorize",
  askLimiter,
  asyncHandler(async (req, res) => {
    const domain = typeof req.query["domain"] === "string" ? req.query["domain"] : "";

    // An unverified claim is not an address (§2.12), and issuing for one would
    // let anybody claim a name and get a certificate attempt made for it.
    // `resolveCustomDomain` filters on the verification in its WHERE clause,
    // and gained the takedown and the trash when this route was written: a
    // name whose project is gone is not a name to make a certificate authority
    // issue for. Decision 13 -- the guarantee is the clause.
    const site = domain ? await resolveCustomDomain(domain) : undefined;

    if (!site) {
      increment("tls_authorize_refused");
      res.status(404).end();
      return;
    }

    increment("tls_authorize_allowed");
    res.status(200).end();
  }),
);

export default router;
