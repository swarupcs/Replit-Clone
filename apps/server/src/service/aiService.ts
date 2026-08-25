import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MAX_FILE_BYTES,
  AI_MAX_HISTORY,
  AI_MAX_MESSAGE_CHARS,
  AI_MAX_PROPOSAL_BYTES,
  AI_MAX_TRANSCRIPT_CHARS,
  type AiActivity,
  type AiEditorContext,
  type AiMessage,
  type AiProposal,
  type AiStatus,
  type AiStopReason,
} from "@replit-clone/shared";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { buildFileTree } from "./fileTreeService.js";
import { getTemplate } from "../templates/registry.js";
import { resolveInProject } from "../utils/projectPaths.js";
import { AppError, BadRequestError } from "../utils/errors.js";

/** The project assistant.
 *
 *  It can read the project, and it can PROPOSE a change to a file — but it
 *  cannot write one, run a command, or touch the container. A proposal is an
 *  offer: it travels to the browser, the editor shows it as a diff against the
 *  buffer, and only a person accepting it puts anything on disk. That is the
 *  whole of the safety story, and it is why the writes never live here.
 */

/** How many times the model may call a tool before we stop it.
 *
 *  Bounds both latency and cost for one question. Eight rounds is far more
 *  than a normal answer needs; anything approaching it is a model going in
 *  circles, and the user gets the partial answer rather than an open tab. */
const MAX_TOOL_ROUNDS = 8;

/** Paths listed in the system prompt. A large project would otherwise spend
 *  most of the context window on a directory listing. */
const MAX_TREE_PATHS = 400;

export function isAiConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export function aiStatus(): AiStatus {
  return { configured: isAiConfigured(), model: env.AI_MODEL };
}

/** Created lazily so this module can be imported — and tested — on a
 *  deployment with no key at all. */
let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new BadRequestError(
      "The assistant is not configured on this server",
      "AI_NOT_CONFIGURED",
    );
  }

  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/* ------------------------------------------------------------------ budget */

interface Window {
  count: number;
  resetAt: number;
}

const HOUR_MS = 60 * 60 * 1000;
const budgets = new Map<string, Window>();

/** Spends one request from a user's hourly allowance.
 *
 *  In memory, so a restart forgives everyone and a second instance keeps its
 *  own tally. That is the wrong shape for a hard spending cap and the right
 *  one for what this actually is: a guard against a runaway client or one
 *  person leaning on the feature, on a deployment that runs a single server.
 */
export function assertWithinAiBudget(userId: string): void {
  const now = Date.now();
  const existing = budgets.get(userId);

  if (!existing || now >= existing.resetAt) {
    budgets.set(userId, { count: 1, resetAt: now + HOUR_MS });
    return;
  }

  if (existing.count >= env.AI_REQUESTS_PER_HOUR) {
    const minutes = Math.max(1, Math.ceil((existing.resetAt - now) / 60_000));
    throw new AppError(
      429,
      "AI_RATE_LIMITED",
      `You have reached this hour's limit for the assistant. Try again in ${String(minutes)} minute${minutes === 1 ? "" : "s"}.`,
    );
  }

  existing.count += 1;
}

/** Only for tests: forgets every tally. */
export function resetAiBudgets(): void {
  budgets.clear();
}

/* ----------------------------------------------------------------- context */

function flattenTree(
  node: { relPath: string; type: string; children?: { relPath: string; type: string; children?: unknown }[] },
  into: string[],
): void {
  if (into.length >= MAX_TREE_PATHS) return;

  if (node.type === "file") {
    if (node.relPath) into.push(node.relPath);
    return;
  }

  for (const child of node.children ?? []) {
    flattenTree(child as Parameters<typeof flattenTree>[0], into);
  }
}

/** Trims a file to the ceiling, saying so rather than cutting silently. */
function clamp(contents: string, label: string): string {
  if (contents.length <= AI_MAX_FILE_BYTES) return contents;

  return (
    `${contents.slice(0, AI_MAX_FILE_BYTES)}\n\n` +
    `[${label} truncated at ${String(AI_MAX_FILE_BYTES)} characters]`
  );
}

async function buildSystemPrompt(
  projectId: string,
  canEdit: boolean,
): Promise<string> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const template = project ? getTemplate(project.template) : undefined;

  const paths: string[] = [];
  try {
    flattenTree(await buildFileTree(projectId), paths);
  } catch {
    // A project whose directory is missing is still worth talking to; the
    // assistant simply has no listing to work from.
  }

  const listing =
    paths.length > 0
      ? paths.join("\n") +
        (paths.length >= MAX_TREE_PATHS ? "\n… (listing truncated)" : "")
      : "(could not read the file listing)";

  return [
    "You are the coding assistant built into a browser IDE, helping with one project.",
    "",
    project ? `Project: ${project.name}` : "",
    template ? `Template: ${template.label} (start command: ${template.startCommand})` : "",
    "",
    "Files in the project:",
    listing,
    "",
    "You can read any of these with the read_file tool. Read before you answer:",
    "a confident answer about code you have not looked at is worse than a slow one.",
    "",
    ...(canEdit
      ? [
          "When a change is worth making, offer it with propose_edit. That writes",
          "nothing: the user gets a diff against their own buffer and decides. So",
          "never say you have changed, edited or fixed a file — say the change is",
          "waiting for their review. Propose only what you have read in full, and",
          "only for files that already exist.",
        ]
      : [
          "This user has read-only access to the project, so you have no way to",
          "offer a change to a file. Show the code and say which file it goes in.",
        ]),
    "",
    "You cannot run commands or install packages — you have no tools for either.",
    "",
    "Keep answers short and concrete. Use fenced code blocks with a language tag,",
    "and label the file above each block. Prefer showing the few lines that change",
    "over restating a whole file.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The editor context, rendered as the opening of the user's turn. */
function renderContext(context: AiEditorContext | undefined): string {
  if (!context?.relPath) return "";

  const parts = [`The user is currently looking at \`${context.relPath}\`.`];

  if (context.selection) {
    parts.push(
      "",
      "They have this selected:",
      "```",
      clamp(context.selection, "Selection"),
      "```",
    );
  }

  if (context.contents !== undefined) {
    parts.push(
      "",
      `Contents of \`${context.relPath}\`:`,
      "```",
      clamp(context.contents, "File"),
      "```",
    );
  }

  return `${parts.join("\n")}\n\n---\n\n`;
}

/* ------------------------------------------------------------------- tools */

const READ_FILE_TOOL: Anthropic.Messages.Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from this project. The path is relative to the " +
    "project root, exactly as it appears in the file listing.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the project root, e.g. src/App.tsx",
      },
    },
    required: ["path"],
  },
};

const PROPOSE_EDIT_TOOL: Anthropic.Messages.Tool = {
  name: "propose_edit",
  description:
    "Offer a change to an existing file for the user to review. This does NOT " +
    "write anything: the user sees your version as a diff against theirs and " +
    "decides. Give the file's COMPLETE new contents, not a patch and not an " +
    "excerpt — whatever you send replaces the file if they accept, so " +
    "anything you leave out is deleted. Read the file first. Use this only " +
    "for files that already exist; to create a new one, show the code and say " +
    "where it goes.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the project root, e.g. src/App.tsx",
      },
      contents: {
        type: "string",
        description: "The complete new contents of the file.",
      },
      summary: {
        type: "string",
        description: "One short line on what this changes, e.g. \"handle the empty case\".",
      },
    },
    required: ["path", "contents", "summary"],
  },
};

/** Unique per proposal so the browser can resolve exactly one card. */
let proposalCounter = 0;

/** Validates one propose_edit call and turns it into a reviewable proposal.
 *
 *  Nothing here writes. The checks are about not wasting the user's attention
 *  on an offer that could never be applied, and about the two ways a proposal
 *  could destroy work if it were accepted unread: a path that escapes the
 *  project, and a rewrite of a file the assistant only ever saw part of.
 */
async function runProposeEdit(
  projectId: string,
  rawInput: unknown,
): Promise<{
  content: string;
  isError: boolean;
  detail: string;
  proposal?: AiProposal;
}> {
  const input = (rawInput ?? {}) as {
    path?: unknown;
    contents?: unknown;
    summary?: unknown;
  };
  const relPath = input.path;
  const contents = input.contents;

  if (typeof relPath !== "string" || relPath.length === 0) {
    return {
      content: "propose_edit needs a `path` string.",
      isError: true,
      detail: "(no path)",
    };
  }

  if (typeof contents !== "string") {
    return {
      content: "propose_edit needs a `contents` string holding the whole file.",
      isError: true,
      detail: relPath,
    };
  }

  if (contents.length > AI_MAX_PROPOSAL_BYTES) {
    return {
      content:
        `\`${relPath}\` is too large to propose in full ` +
        `(the limit is ${String(AI_MAX_PROPOSAL_BYTES)} characters). ` +
        "Show the change as code in your answer instead.",
      isError: true,
      detail: relPath,
    };
  }

  try {
    const absolute = resolveInProject(projectId, relPath);
    const stats = await fs.stat(absolute);

    if (stats.isDirectory()) {
      return {
        content: `\`${relPath}\` is a directory, not a file.`,
        isError: true,
        detail: relPath,
      };
    }

    // The assistant is offering to REPLACE this file. If the file is larger
    // than it is allowed to see in one piece, then whatever it read was
    // truncated, and its version is missing the tail whether it knows that or
    // not. Accepting that proposal would delete the rest of the file.
    if (stats.size > AI_MAX_PROPOSAL_BYTES) {
      return {
        content:
          `\`${relPath}\` is larger than you can be shown in full, so a ` +
          "replacement would drop the part you never saw. Describe the change " +
          "in your answer instead.",
        isError: true,
        detail: relPath,
      };
    }
  } catch (error) {
    if (error instanceof AppError) {
      // A path that escapes the project, reported to the model in its terms.
      return { content: error.message, isError: true, detail: relPath };
    }
    return {
      content:
        `\`${relPath}\` does not exist. propose_edit only changes files that ` +
        "are already there; to create one, show the code and say where it goes.",
      isError: true,
      detail: relPath,
    };
  }

  proposalCounter += 1;
  const summary =
    typeof input.summary === "string" && input.summary.trim() !== ""
      ? input.summary.trim()
      : "Proposed change";

  return {
    // Said plainly, because a model told "done" will tell the user it made the
    // change — and it has not. Nothing is on disk until a person accepts.
    content:
      `Proposed. \`${relPath}\` is waiting for the user to review the diff and ` +
      "accept or discard it. Nothing has been written. Do not tell them the " +
      "change is made; tell them it is waiting for review.",
    isError: false,
    detail: relPath,
    proposal: {
      id: `proposal-${String(proposalCounter)}`,
      relPath,
      contents,
      summary,
    },
  };
}

/** Runs one read_file call.
 *
 *  Every path goes through `resolveInProject`, the same choke point the editor
 *  and the upload endpoint use, so the assistant cannot be talked into reading
 *  outside the project by anything a user types. Failures come back to the
 *  model as text rather than throwing: "that file does not exist" is something
 *  it can recover from by trying the right path.
 */
async function runReadFile(
  projectId: string,
  rawInput: unknown,
): Promise<{ content: string; isError: boolean; detail: string }> {
  const relPath =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as { path?: unknown }).path
      : undefined;

  if (typeof relPath !== "string" || relPath.length === 0) {
    return {
      content: "read_file needs a `path` string.",
      isError: true,
      detail: "(no path)",
    };
  }

  try {
    const absolute = resolveInProject(projectId, relPath);
    const stats = await fs.stat(absolute);

    if (stats.isDirectory()) {
      return {
        content: `\`${relPath}\` is a directory, not a file.`,
        isError: true,
        detail: relPath,
      };
    }

    const contents = await fs.readFile(absolute, "utf8");
    return { content: clamp(contents, "File"), isError: false, detail: relPath };
  } catch (error) {
    if (error instanceof AppError) {
      // A traversal attempt, reported to the model in its own terms.
      return { content: error.message, isError: true, detail: relPath };
    }
    return {
      content: `Could not read \`${relPath}\` — it may not exist.`,
      isError: true,
      detail: relPath,
    };
  }
}

interface ToolOutcome {
  content: string;
  isError: boolean;
  detail: string;
  proposal?: AiProposal;
}

/** Dispatches one tool call.
 *
 *  A tool the caller was not given is treated as unknown rather than run —
 *  the model is told what it may use, but what it may DO is decided here.
 */
async function runTool(
  projectId: string,
  use: Anthropic.Messages.ToolUseBlock,
  canEdit: boolean,
): Promise<ToolOutcome> {
  if (use.name === READ_FILE_TOOL.name) {
    return runReadFile(projectId, use.input);
  }

  if (use.name === PROPOSE_EDIT_TOOL.name && canEdit) {
    return runProposeEdit(projectId, use.input);
  }

  return {
    content: `Unknown tool \`${use.name}\`.`,
    isError: true,
    detail: use.name,
  };
}

/* -------------------------------------------------------------- transcript */

/** The transcript, bounded and checked, in the order it will be sent.
 *
 *  Everything here arrives from the browser over a socket, so none of it is
 *  trusted: the shape is checked, and both the size of one message and the size
 *  of the whole conversation are capped. The history LIMIT bounded the number
 *  of turns and nothing bounded their length, which left the cost of a single
 *  question open-ended — the hourly budget counts requests, and a request that
 *  can carry a megabyte is not a budget.
 *
 *  The newest message is REFUSED when it is over the ceiling, because it is the
 *  one the user just wrote and silently sending a trimmed version of somebody's
 *  question is worse than telling them it did not fit. Older turns are trimmed
 *  instead: they have already been answered, and refusing the whole
 *  conversation over something further up it would strand the user with a
 *  thread they can no longer use.
 */
/** Says so, rather than cutting an earlier turn off mid-sentence. */
const TRUNCATION_MARKER = "\n\n[earlier message truncated]";

export function prepareTranscript(messages: AiMessage[]): AiMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError("Ask a question first", "AI_EMPTY_REQUEST");
  }

  for (const message of messages) {
    if (
      typeof message?.content !== "string" ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      throw new BadRequestError(
        "That conversation is not in a shape the assistant can read",
        "AI_BAD_REQUEST",
      );
    }
  }

  const newest = messages[messages.length - 1];
  if (newest && newest.content.length > AI_MAX_MESSAGE_CHARS) {
    throw new BadRequestError(
      `That message is too long (the limit is ${String(AI_MAX_MESSAGE_CHARS)} ` +
        "characters). Open the file instead — the assistant can read it.",
      "AI_MESSAGE_TOO_LONG",
    );
  }

  // Oldest first out, on both counts: the follow-up refers to the last few
  // turns, so what has to go is always the front of the thread.
  const recent = messages.slice(-AI_MAX_HISTORY).map((message) =>
    message.content.length > AI_MAX_MESSAGE_CHARS
      ? {
          ...message,
          content:
            message.content.slice(0, AI_MAX_MESSAGE_CHARS) +
            TRUNCATION_MARKER,
        }
      : message,
  );

  const kept: AiMessage[] = [];
  let total = 0;

  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index];
    if (!message) continue;

    // The newest is kept whatever the running total says: it is under the
    // per-message cap by the check above, and a question with no question in
    // it is not worth sending.
    if (kept.length > 0 && total + message.content.length > AI_MAX_TRANSCRIPT_CHARS) {
      break;
    }

    kept.unshift(message);
    total += message.content.length;
  }

  return kept;
}

/* ------------------------------------------------------------------ stream */

export interface StreamOptions {
  projectId: string;
  messages: AiMessage[];
  context?: AiEditorContext;
  /** Aborts the reply mid-flight. */
  signal: AbortSignal;
  /** Whether this user may change the project at all.
   *
   *  A viewer gets the assistant — reading and explaining is exactly what
   *  read-only access is for — but is not offered a tool whose only purpose is
   *  to produce a change they could not apply. Withholding the tool is better
   *  than refusing each call: the model plans around what it has. */
  canEdit: boolean;
  onDelta: (text: string) => void;
  onActivity: (activity: AiActivity) => void;
  /** A change the assistant is offering. Nothing has been written. */
  onProposal: (proposal: AiProposal) => void;
}

/** Answers one question, streaming the reply.
 *
 *  Resolves with why it stopped. Cancellation is not an error: the user has
 *  the part that already streamed, and treating it as a failure would replace
 *  a useful partial answer with an error message.
 */
export async function streamAssistantReply(
  options: StreamOptions,
): Promise<AiStopReason> {
  const {
    projectId,
    messages,
    context,
    signal,
    canEdit,
    onDelta,
    onActivity,
    onProposal,
  } = options;

  // Checked and bounded before anything is spent on it: the client is the
  // browser, and the browser is not trusted with how large a question is.
  const recent = prepareTranscript(messages);

  const anthropic = getClient();
  const system = await buildSystemPrompt(projectId, canEdit);
  const tools = canEdit
    ? [READ_FILE_TOOL, PROPOSE_EDIT_TOOL]
    : [READ_FILE_TOOL];

  const conversation: Anthropic.Messages.MessageParam[] = recent.map(
    (message, index) => ({
      role: message.role,
      content:
        // The context block rides the LAST user turn, so it describes what is
        // on screen NOW rather than what was open when the thread started.
        index === recent.length - 1 && message.role === "user"
          ? `${renderContext(context)}${message.content}`
          : message.content,
    }),
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) return "cancelled";

    const stream = anthropic.messages.stream(
      {
        model: env.AI_MODEL,
        max_tokens: env.AI_MAX_TOKENS,
        system,
        messages: conversation,
        tools,
      },
      { signal },
    );

    stream.on("text", (delta: string) => {
      onDelta(delta);
    });

    let final: Anthropic.Messages.Message;
    try {
      final = await stream.finalMessage();
    } catch (error) {
      if (signal.aborted) return "cancelled";
      throw error;
    }

    if (final.stop_reason === "max_tokens") return "max_tokens";
    if (final.stop_reason !== "tool_use") return "complete";

    const toolUses = final.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use",
    );

    if (toolUses.length === 0) return "complete";

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      if (signal.aborted) return "cancelled";

      // Anything not in `tools` is the model inventing one — including
      // propose_edit when this user is a viewer, which is the case that
      // matters: a tool it was never given cannot be talked into existing.
      const outcome = await runTool(projectId, use, canEdit);

      increment("ai_tool_calls");
      onActivity({ tool: use.name, detail: outcome.detail });

      // Reported only once the call has been validated, so a proposal the user
      // sees is one that could actually be applied.
      if (outcome.proposal) {
        increment("ai_proposals");
        onProposal(outcome.proposal);
      }

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }

    conversation.push(
      { role: "assistant", content: final.content },
      { role: "user", content: results },
    );
  }

  logger.warn("assistant hit the tool-round ceiling", {
    projectId,
    rounds: MAX_TOOL_ROUNDS,
  });
  return "max_rounds";
}
