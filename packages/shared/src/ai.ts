/** The AI assistant's wire contract.
 *
 *  The transcript the client holds is deliberately plain: two roles and text.
 *  Tool traffic — the assistant reading a file to answer a question — never
 *  reaches the browser as messages, because replaying it on the next turn would
 *  mean the client had to reconstruct a valid tool_use/tool_result pairing to
 *  send back, and one malformed history would break the conversation. The
 *  server runs that loop and reports it as `AiActivity` for display only.
 */

export type AiRole = "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

/** What the user is looking at when they ask.
 *
 *  Sent with every question rather than fetched by the assistant, because "why
 *  is this broken?" almost always means the file on screen, and spending a tool
 *  round to discover that makes the first token slower for no benefit.
 */
export interface AiEditorContext {
  /** Path of the active editor tab, relative to the project root. */
  relPath?: string;
  /** Its contents. Truncated by the server if the file is large. */
  contents?: string;
  /** Whatever was selected, when the question is about one passage. */
  selection?: string;
}

export interface AiAskPayload {
  /** The whole conversation so far, this question last. */
  messages: AiMessage[];
  context?: AiEditorContext;
}

/** Something the assistant did on the way to its answer.
 *
 *  Shown so a pause is legible: "Reading src/App.tsx" is a far better thing to
 *  look at than a spinner that stalls for three seconds.
 */
export interface AiActivity {
  tool: string;
  detail: string;
}

/** Why a reply ended, so the UI can say so rather than just stopping. */
export type AiStopReason = "complete" | "cancelled" | "max_tokens" | "max_rounds";

/** GET /api/v1/ai/status — mirrors the sign-in providers endpoint, so the web
 *  app can hide the feature entirely on a deployment with no key configured. */
export interface AiStatus {
  configured: boolean;
  /** Which model answers here. Shown in the panel so it is never a mystery. */
  model: string;
}

/** Largest single file the assistant will be given, whether as editor context
 *  or through its own read. Past this it is truncated with a marker, which is
 *  more useful than refusing outright. */
export const AI_MAX_FILE_BYTES = 80_000;

/** How many messages of history travel with a question. Older turns are
 *  dropped from the front: the transcript is bounded, but the last exchanges —
 *  the ones the follow-up refers to — always survive. */
export const AI_MAX_HISTORY = 40;

/** A change the assistant would like to make, for a person to review.
 *
 *  The assistant still never writes. It proposes, the editor shows the proposal
 *  against what is in the buffer, and nothing reaches the project until someone
 *  has read that diff and accepted it. Accepting applies the change through the
 *  editor's own model, so Ctrl+Z undoes it like any other edit — the two things
 *  this feature was waiting on.
 *
 *  A proposal carries the file's WHOLE new contents rather than a patch. A
 *  patch has to be applied by matching context that may have moved, and a near
 *  miss silently lands in the wrong place; full contents either diff cleanly or
 *  not at all. The cost is that the assistant has to reproduce the file, which
 *  is why proposals are capped and confined to files that already exist.
 */
export interface AiProposal {
  /** Unique within a conversation, so accepting one card cannot resolve another
   *  — the assistant may propose several changes in a single reply. */
  id: string;
  /** Path relative to the project root, resolved and confined server-side. */
  relPath: string;
  /** The file as the assistant would have it, in full. */
  contents: string;
  /** One line on what this changes, shown on the card. */
  summary: string;
}

/** Largest file the assistant may propose replacing.
 *
 *  Below `AI_MAX_FILE_BYTES`, deliberately: a file the assistant only ever saw
 *  TRUNCATED is one it cannot rewrite without dropping the part it never read,
 *  and a proposal that silently deletes the tail of a file is the exact failure
 *  this whole review step exists to prevent.
 */
export const AI_MAX_PROPOSAL_BYTES = 40_000;
