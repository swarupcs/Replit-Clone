import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MAX_FILE_BYTES,
  AI_MAX_HISTORY,
  type AiActivity,
  type AiEditorContext,
  type AiMessage,
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
 *  Deliberately READ-ONLY. It can look at the project and explain, review or
 *  draft code, but it cannot write a file, run a command, or touch the
 *  container. An assistant that edits the tree needs a diff to approve and an
 *  undo to fall back on, and shipping the writes before either of those exist
 *  would mean the first bad suggestion silently overwrites someone's work.
 *  Answers come back as text the user applies themselves.
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

async function buildSystemPrompt(projectId: string): Promise<string> {
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
    "You cannot edit files, run commands, or install packages — you have no tools",
    "for any of that. When a change is needed, show the code and say which file it",
    "goes in; the user applies it themselves. Never claim to have made a change.",
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

/* ------------------------------------------------------------------ stream */

export interface StreamOptions {
  projectId: string;
  messages: AiMessage[];
  context?: AiEditorContext;
  /** Aborts the reply mid-flight. */
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onActivity: (activity: AiActivity) => void;
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
  const { projectId, messages, context, signal, onDelta, onActivity } = options;

  if (messages.length === 0) {
    throw new BadRequestError("Ask a question first", "AI_EMPTY_REQUEST");
  }

  const anthropic = getClient();
  const system = await buildSystemPrompt(projectId);

  // Oldest turns fall off the front: the follow-up almost always refers to the
  // last few, and an unbounded transcript is an unbounded bill.
  const recent = messages.slice(-AI_MAX_HISTORY);
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
        tools: [READ_FILE_TOOL],
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

      // Only one tool exists; anything else is the model inventing one.
      const outcome =
        use.name === READ_FILE_TOOL.name
          ? await runReadFile(projectId, use.input)
          : {
              content: `Unknown tool \`${use.name}\`.`,
              isError: true,
              detail: use.name,
            };

      increment("ai_tool_calls");
      onActivity({ tool: use.name, detail: outcome.detail });

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
