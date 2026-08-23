import type { AiAskPayload } from "@replit-clone/shared";
import {
  assertWithinAiBudget,
  isAiConfigured,
  streamAssistantReply,
} from "../service/aiService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import type { EditorSocket } from "./editorHandler.js";

/** The assistant's half of the editor socket.
 *
 *  Split out of editorHandler because it owns state that file operations do
 *  not: exactly one reply may be in flight per socket, and it has to be
 *  abortable from three directions — the user pressing stop, a second question
 *  arriving, and the socket closing.
 */

/** Deliberately allowed for a VIEWER.
 *
 *  Everything the assistant can do on its own is read the project and talk
 *  about it, which is precisely what read-only access is for; making it
 *  editor-only would refuse a read-only feature to read-only users for no
 *  reason. The cost it incurs is bounded per USER by the hourly budget, which
 *  is the right control for a bill — an access level is not one.
 *
 *  What a viewer does not get is `propose_edit`. It writes nothing either, but
 *  its whole purpose is to produce a change, and offering one to somebody who
 *  cannot apply it is a dead end dressed up as a feature.
 */
export function installAiHandler(socket: EditorSocket): void {
  const { projectId, userId } = socket.data;

  /** The reply currently streaming, if any. */
  let inFlight: AbortController | null = null;

  function cancelInFlight(): void {
    inFlight?.abort();
    inFlight = null;
  }

  socket.on("aiCancel", cancelInFlight);
  socket.on("disconnect", cancelInFlight);

  socket.on("aiAsk", (payload: AiAskPayload) => {
    void (async () => {
      if (!isAiConfigured()) {
        socket.emit("aiError", {
          code: "AI_NOT_CONFIGURED",
          message: "The assistant is not configured on this server.",
        });
        return;
      }

      // A second question supersedes the first rather than racing it: two
      // streams writing into one transcript interleave into nonsense.
      cancelInFlight();

      const controller = new AbortController();
      inFlight = controller;

      try {
        assertWithinAiBudget(userId);
        increment("ai_requests");

        const stopReason = await streamAssistantReply({
          projectId,
          messages: payload.messages,
          context: payload.context,
          signal: controller.signal,
          // Read at ASK time, not at connect: access can be revoked or
          // demoted while a socket is open, and the level that matters is the
          // one in force when the question is asked.
          canEdit:
            socket.data.accessLevel === "editor" ||
            socket.data.accessLevel === "owner",
          onDelta: (text) => {
            // Guarded: a cancelled stream can emit one more chunk before it
            // unwinds, and that chunk belongs to a reply the user has already
            // dismissed.
            if (!controller.signal.aborted) socket.emit("aiDelta", { text });
          },
          onActivity: (activity) => {
            if (!controller.signal.aborted) socket.emit("aiActivity", activity);
          },
          onProposal: (proposal) => {
            // A cancelled reply's proposals go with it: the user stopped this
            // answer, and a card outliving it would be an offer from a
            // conversation they already dismissed.
            if (!controller.signal.aborted) socket.emit("aiProposal", proposal);
          },
        });

        if (!controller.signal.aborted) socket.emit("aiDone", { stopReason });
      } catch (error) {
        if (controller.signal.aborted) return;

        if (error instanceof AppError) {
          socket.emit("aiError", { code: error.code, message: error.message });
          return;
        }

        increment("ai_errors");
        logger.error("assistant request failed", error, { projectId });
        socket.emit("aiError", {
          code: "AI_FAILED",
          message: "The assistant could not answer that. Try again.",
        });
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    })();
  });
}
