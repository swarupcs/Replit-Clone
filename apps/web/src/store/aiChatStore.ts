import { create } from "zustand";
import type { AiActivity, AiMessage, AiStopReason } from "@replit-clone/shared";

/** The assistant's conversation, for one project at a time.
 *
 *  Deliberately in memory and not persisted. A transcript that survives a
 *  reload has to be stored somewhere, and the honest options are a database
 *  table nobody asked for or localStorage — which would put whatever a user
 *  pasted into the chat, including secrets from a file they were debugging,
 *  on disk in the browser indefinitely. Reloading starts a fresh thread.
 */

/** Why the last reply ended, when that is worth saying out loud. */
export type ChatNotice =
  | { kind: "error"; message: string }
  | { kind: "stopped"; reason: AiStopReason };

interface AiChatStore {
  /** Which project this transcript belongs to, so opening another one does not
   *  inherit it. */
  projectId: string | null;
  messages: AiMessage[];
  /** True from the moment a question is sent until `aiDone` or `aiError`. */
  streaming: boolean;
  /** What the assistant is doing right now, cleared when the reply ends. */
  activity: AiActivity | null;
  notice: ChatNotice | null;

  /** Points the store at a project, clearing the thread if it changed. */
  setProject: (projectId: string) => void;
  /** Records the question and opens an empty assistant turn to stream into. */
  ask: (question: string) => void;
  appendDelta: (text: string) => void;
  setActivity: (activity: AiActivity | null) => void;
  finish: (reason: AiStopReason) => void;
  fail: (message: string) => void;
  /** Local stop: keeps whatever streamed, ends the turn. */
  cancel: () => void;
  clear: () => void;
  dismissNotice: () => void;
}

/** Appends to the last message, which is always the assistant turn in flight. */
function appendToLast(messages: AiMessage[], text: string): AiMessage[] {
  if (messages.length === 0) return messages;

  const head = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (!last) return messages;

  return [...head, { ...last, content: last.content + text }];
}

/** Drops a trailing assistant turn that never received a single token.
 *
 *  Without this a failed or instantly-cancelled request leaves an empty bubble
 *  in the transcript, which then travels back to the server as part of the
 *  history on the next question.
 */
function pruneEmptyReply(messages: AiMessage[]): AiMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.content === "") return messages.slice(0, -1);
  return messages;
}

export const useAiChatStore = create<AiChatStore>((set) => ({
  projectId: null,
  messages: [],
  streaming: false,
  activity: null,
  notice: null,

  setProject: (projectId) => {
    set((state) =>
      state.projectId === projectId
        ? state
        : { projectId, messages: [], streaming: false, activity: null, notice: null },
    );
  },

  ask: (question) => {
    set((state) => ({
      messages: [
        ...state.messages,
        { role: "user", content: question },
        // The turn the deltas stream into. Created up front so the UI has
        // something to render the moment the request leaves.
        { role: "assistant", content: "" },
      ],
      streaming: true,
      activity: null,
      notice: null,
    }));
  },

  appendDelta: (text) => {
    set((state) =>
      state.streaming
        ? { messages: appendToLast(state.messages, text), activity: null }
        : state,
    );
  },

  setActivity: (activity) => {
    set({ activity });
  },

  finish: (reason) => {
    set((state) => ({
      messages: pruneEmptyReply(state.messages),
      streaming: false,
      activity: null,
      // "Complete" is the expected outcome and needs no announcement; the
      // other reasons explain a reply that stops looking unfinished.
      notice: reason === "complete" ? null : { kind: "stopped", reason },
    }));
  },

  fail: (message) => {
    set((state) => ({
      messages: pruneEmptyReply(state.messages),
      streaming: false,
      activity: null,
      notice: { kind: "error", message },
    }));
  },

  cancel: () => {
    set((state) => ({
      messages: pruneEmptyReply(state.messages),
      streaming: false,
      activity: null,
    }));
  },

  clear: () => {
    set({ messages: [], streaming: false, activity: null, notice: null });
  },

  dismissNotice: () => {
    set({ notice: null });
  },
}));
