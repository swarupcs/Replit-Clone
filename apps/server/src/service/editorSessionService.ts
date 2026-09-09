import type { Prisma } from "../generated/prisma/client.js";
import {
  MAX_SESSION_VALUE_BYTES,
  SESSION_KEYS,
  isSessionKey,
  type EditorSessionState,
  type SessionEntry,
  type SessionKey,
} from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../utils/errors.js";

/** Where the editor was left, against the account rather than the browser.
 *  plan.md §13.11.
 *
 *  **What was wrong.** `editorSettingsStore`, `keybindingStore`,
 *  `workspaceStore` and `themeStore` all persisted to `localStorage`. Open the
 *  same workspace from a second machine — which is the *reason* the workspace
 *  is on a server — and it was a blank editor, default settings, no open
 *  files, and the keybindings somebody had spent a month building were on the
 *  other laptop.
 *
 *  **What this deliberately is not.** Not §10.9. That row wants settings in
 *  *files*: committable, diffable, per-workspace, importable from a real VS
 *  Code profile, and it is behind §10.1. This is the *session* — which tabs
 *  were open, where the splits were, what the tree had expanded — living
 *  against the account. The two are one sentence apart and blocked on
 *  different things, which is why §13 named them separately.
 *
 *  **The conflict rule, said out loud because there is one.** A row per key,
 *  so two machines changing different things never touch the same row. Within
 *  one key it is last write wins. That is not a merge and does not pretend to
 *  be: merging two sets of open tabs produces an arrangement neither person
 *  asked for, and "the thing I did most recently is what I see" is what
 *  somebody expects of their own settings. `rev` exists so a client can tell
 *  its own write from somebody else's and skip feeding its own value back
 *  through the store, not to reject a write.
 *
 *  **The value is opaque here on purpose.** The shape belongs to the client
 *  that wrote it. A server that validated today's shape would reject a client
 *  one version ahead of it, and the failure would be a browser that silently
 *  stops saving. What the server does enforce is the two things that are its
 *  business: which keys exist, and how big one may be.
 */

/** How the API describes one stored store. */
function toEntry(row: {
  value: Prisma.JsonValue;
  rev: number;
  updatedAt: Date;
}): SessionEntry {
  return {
    value: row.value,
    rev: row.rev,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getEditorSession(userId: string): Promise<EditorSessionState> {
  const rows = await prisma.userEditorState.findMany({
    where: { userId, key: { in: [...SESSION_KEYS] } },
    select: { key: true, value: true, rev: true, updatedAt: true },
  });

  const entries: EditorSessionState["entries"] = {};
  for (const row of rows) {
    // Filtered again on the way out, not only in the query: a key that left
    // the allowlist after it was written should stop being served, and the
    // narrowing is what makes the returned object match its declared type.
    if (isSessionKey(row.key)) entries[row.key] = toEntry(row);
  }

  return { entries };
}

/** Validates a submitted patch, and says what is wrong in terms of the thing
 *  the caller sent rather than in terms of the table.
 *
 *  Whole-patch validation before any write, so a request naming one bad key
 *  does not leave the other three applied. A partially applied save is the
 *  state nobody can reason about afterwards. */
export function parseSessionUpdate(body: unknown): Map<SessionKey, unknown> {
  const raw = (body as { entries?: unknown } | undefined)?.entries;

  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("Expected an object of entries");
  }

  const parsed = new Map<SessionKey, unknown>();

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSessionKey(key)) {
      throw new BadRequestError(`${key} is not a syncable setting`);
    }

    // `undefined` does not survive JSON, so this is a client sending an
    // explicit null. Storing it would hand the next machine a null where its
    // store expects an object; deletion is the honest reading of "I have
    // nothing for this key".
    if (value === null) {
      parsed.set(key, null);
      continue;
    }

    const size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (size > MAX_SESSION_VALUE_BYTES) {
      throw new BadRequestError(
        `${key} is too large to sync (${String(size)} bytes)`,
      );
    }

    parsed.set(key, value);
  }

  return parsed;
}

export async function setEditorSession(
  userId: string,
  body: unknown,
): Promise<EditorSessionState> {
  const patch = parseSessionUpdate(body);

  for (const [key, value] of patch) {
    if (value === null) {
      // `deleteMany` rather than `delete`: deleting a key that was never
      // stored is what a client that has just reset a store sends, and it is
      // not an error.
      await prisma.userEditorState.deleteMany({ where: { userId, key } });
      continue;
    }

    const json = value as Prisma.InputJsonValue;
    await prisma.userEditorState.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: json },
      // `increment` rather than a read-then-write: two tabs saving at the same
      // instant would otherwise both compute the same next revision, and a
      // revision that repeats is one a client cannot use to tell writes apart.
      update: { value: json, rev: { increment: 1 } },
    });
  }

  // Re-read rather than echo, so what the client renders next is what is
  // stored -- including the revisions, which the caller cannot compute.
  return getEditorSession(userId);
}
