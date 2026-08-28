import type { RequestHandler } from "express";

/** The API's own answer to what helmet has to leave off.
 *
 *  `helmet({ contentSecurityPolicy: false })` in `index.ts` is set for one
 *  real reason: with `PREVIEW_PORT=0` that same app also proxies project
 *  previews, and those are arbitrary user code that a policy of ours would
 *  break. But the exemption was applied to the WHOLE app, so the API's own
 *  responses -- which are JSON and load nothing at all -- carried no policy
 *  either, and the origin was framable by any page that cared to.
 *
 *  So this is the strictest policy that could possibly apply to JSON, on
 *  everything except the preview path. `default-src 'none'` is safe precisely
 *  because nothing served here is a document: the one endpoint that returns
 *  bytes rather than JSON forces `attachment` with `nosniff`, so a browser
 *  downloads it rather than rendering it.
 */
export function apiSecurityHeaders(previewsShareThisOrigin: boolean): RequestHandler {
  return (req, res, next) => {
    // The exemption, stated as narrowly as it can be: only when previews
    // actually share this origin, and only for their own path. Stated any
    // wider and it is the blanket exemption this exists to replace.
    if (previewsShareThisOrigin && req.path.startsWith("/preview/")) {
      next();
      return;
    }

    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    // helmet's default is SAMEORIGIN, which is more than the API needs:
    // nothing frames it, ourselves included.
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };
}
