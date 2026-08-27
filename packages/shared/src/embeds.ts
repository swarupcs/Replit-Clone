/** Putting a project inside somebody else's page.
 *
 *  Every other way into a project needs an account here. A share link needs one
 *  (redeeming it adds you as a collaborator), the preview needs a session
 *  cookie, and the editor needs both. That makes the project unusable in the
 *  one place a code sandbox earns its keep: a blog post, a documentation page,
 *  a bug report, a course — read by people who will never sign up, in a page
 *  whose author cannot ask them to.
 *
 *  An embed is the answer CodeSandbox settled on: an iframe showing the code
 *  and, beside it, the thing the code produces. It is a PUBLISHING action, not
 *  a sharing one — the audience is everybody, and the credential in the URL is
 *  read-only by construction rather than by permission check.
 */

/** Which halves of the embed are shown.
 *
 *  Named for what the reader sees rather than for a layout, because the frame
 *  is often narrow enough that "split" collapses to tabs anyway.
 */
export type EmbedView = "code" | "preview" | "split";

/** What the preview half shows.
 *
 *  Deliberately only two values today. The obvious third — the project's own
 *  running dev server — is not here on purpose: see `EmbedSettings.preview`.
 */
export type EmbedPreview = "none" | "deployment";

/** What an embed shows, chosen by the project's owner.
 *
 *  Stored on the embed rather than read from the URL so that the owner controls
 *  the default, and so a snippet pasted years ago keeps working when they
 *  change their mind. The URL may still override `view` and `file`, because
 *  those are presentation and an author embedding the same project twice
 *  should not need two tokens.
 */
export interface EmbedSettings {
  view: EmbedView;
  /** `"deployment"` frames the project's published site, which is already
   *  public, already built, and costs nothing per view.
   *
   *  There is no `"live"` here yet. A live preview means an anonymous page view
   *  can START A CONTAINER on the owner's behalf — one embed on a busy page
   *  would hold their container up permanently, count against their limit, and
   *  serve their environment variables to whoever asked. That is the abuse
   *  surface the platform has not built controls for, and an embed is exactly
   *  the wrong place to discover it. */
  preview: EmbedPreview;
  /** Which file opens first, as a project-relative POSIX path. Null means the
   *  first file the tree offers. */
  activeFile: string | null;
}

/** What the owner sees and changes in the share dialog. */
export interface EmbedState {
  /** Null when the project has no embed. Creating one mints it. */
  token: string | null;
  settings: EmbedSettings;
  /** True when the project has a live deployment, so the dialog can say why
   *  the preview half will be empty rather than offering a dead option. */
  hasDeployment: boolean;
  /** Paths the embed will NOT serve, because they matched the secret rules
   *  below. Shown to the owner: "we hid these" is useful, "we hid something"
   *  is not. */
  hiddenPaths: string[];
}

/** One file, as an anonymous reader may see it listed. */
export interface EmbedFile {
  relPath: string;
  size: number;
}

/** Everything the embed page needs to render, in one anonymous request. */
export interface EmbedPayload {
  projectName: string;
  template: string;
  view: EmbedView;
  activeFile: string | null;
  files: EmbedFile[];
  /** Absolute URL of the published site, or null when there is nothing to
   *  frame — either the owner chose `preview: "none"` or the project has never
   *  been deployed. */
  previewUrl: string | null;
  /** Deep link back to the full project. Anonymous readers cannot open it
   *  without an account, which is the point: an embed is a shop window. */
  projectUrl: string | null;
}

/** One file's contents, fetched when the reader opens it. */
export interface EmbedFileContents {
  relPath: string;
  contents: string;
  /** True when the file was longer than `MAX_EMBED_FILE_BYTES` and what came
   *  back is the beginning of it. Said out loud, because silently showing two
   *  thirds of a file is how somebody reads a bug that is not there. */
  truncated: boolean;
}

/** Ceiling on one file served through an embed.
 *
 *  An embed is a reading surface, not a download endpoint, and it is
 *  unauthenticated — so the generous limits the editor gives a signed-in
 *  collaborator do not apply. 256 KB is far past any file somebody meant to
 *  put in front of a reader.
 */
export const MAX_EMBED_FILE_BYTES = 256 * 1024;

/** Files an embed never serves, whatever the tree says.
 *
 *  An embed publishes source to the entire internet on a link the owner will
 *  paste and forget, and the single file people forget about is the one this
 *  platform itself teaches them to create. This is not a substitute for the
 *  owner's judgement and the dialog says so — it is a floor, so the default
 *  behaviour of "embed my project" is not "leak my API keys".
 *
 *  Kept as patterns rather than exact names because the interesting cases are
 *  variants: `.env.local`, `.env.production`, `credentials.json`.
 */
const SECRET_PATTERNS: RegExp[] = [
  // .env, .env.local, .env.production.local, and anything.env
  /(^|\/)\.env(\.|$)/i,
  // Private keys in every shape they ship in.
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  // Registry and host credentials.
  /(^|\/)\.(npmrc|netrc|pgpass|htpasswd)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  // Service-account JSON, by the names the tools that emit it use.
  /(^|\/)(credentials|service-account|serviceaccount)[^/]*\.json$/i,
  // Anything the author already marked as secret.
  /(^|\/)secrets?\.(json|ya?ml|toml|ini)$/i,
];

/** Whether an embed must refuse to list or serve this path.
 *
 *  Shared rather than server-only so the owner's dialog can name the files that
 *  will be hidden, using the same rule that will actually hide them.
 */
export function isSecretPath(relPath: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(relPath));
}

/** A token is 32 random bytes, base64url. Checked before it reaches a database
 *  query so an obviously malformed one costs nothing. */
export const EMBED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
