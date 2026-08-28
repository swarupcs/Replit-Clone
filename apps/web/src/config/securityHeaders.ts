/** What the web origin says about itself, on every response.
 *
 *  Two servers deliver this app -- Vite in development, nginx in the image --
 *  and a header set on one and not the other is worse than one set on neither:
 *  it works locally and is absent exactly where it matters. So the values live
 *  here, the dev server reads them directly, and a test asserts `nginx.conf`
 *  still agrees.
 *
 *  Deliberately NOT a full policy. There is no `default-src` and no
 *  `script-src`, because Monaco loads its workers from blob: URLs and its
 *  TypeScript worker needs eval -- a strict script policy here produces a
 *  white editor rather than a secure one. What is set are the directives that
 *  hold whatever the app does, which is the same line the preview proxy's own
 *  CSP already takes.
 */

/** The IDE, the dashboard, the sign-in pages: everything but an embed.
 *
 *  `frame-ancestors 'none'` is the point of the exercise. A page able to frame
 *  the editor is showing a real IDE, carrying the reader's real session, under
 *  markup of the framing site's choosing -- the file tree and the Run button
 *  positioned under whatever that page wants clicked. Nothing legitimately
 *  frames it.
 */
export const APP_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  // What browsers too old to read frame-ancestors understand. The same
  // statement, and cheap.
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** An embed, which exists to be framed by pages this platform will never see.
 *
 *  Identical but for the framing rule, which is dropped rather than loosened:
 *  the whole feature is somebody else's article putting a project in an
 *  iframe, and `frame-ancestors 'none'` here would break every one of them.
 */
export const EMBED_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "base-uri 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Which set a given path gets. */
export function headersFor(pathname: string): Record<string, string> {
  return pathname.startsWith("/embed/") ? EMBED_HEADERS : APP_HEADERS;
}
