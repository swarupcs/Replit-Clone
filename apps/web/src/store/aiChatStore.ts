import { create } from "zustand";
import type {
  AiActivity,
  AiMessage,
  AiProposal,
  AiStopReason,
} from "@replit-clone/shared";

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

/** A change the assistant has offered, and the turn it arrived on.
 *
 *  Held next to the transcript rather than inside it, because a proposal is not
 *  something the assistant SAID — it never travels back as history. The index
 *  is only so the card renders under the reply that produced it. */
export interface PendingProposal {
  proposal: AiProposal;
  messageIndex: number;
}

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
  /** Offered changes not yet accepted or discarded. */
  proposals: PendingProposal[];

  /** Points the store at a project, clearing the thread if it changed. */
  setProject: (projectId: string) => void;
  /** Records the question and opens an empty assistant turn to stream into. */
  ask: (question: string) => void;
  appendDelta: (text: string) => void;
  /** Files a change the assistant is offering against the reply in flight. */
  addProposal: (proposal: AiProposal) => void;
  /** Takes a card away once it has been accepted or discarded. */
  resolveProposal: (id: string) => void;
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

/** Drops cards whose turn is no longer in the transcript.
 *
 *  A reply that produced a proposal and then failed before writing a word gets
 *  pruned, and its card would otherwise be left pointing past the end of the
 *  list — rendered under whichever message later took that index. */
function pruneOrphanedProposals(
  proposals: PendingProposal[],
  messageCount: number,
): PendingProposal[] {
  return proposals.filter((entry) => entry.messageIndex < messageCount);
}

export const useAiChatStore = create<AiChatStore>((set) => ({
  projectId: null,
  messages: [],
  streaming: false,
  activity: null,
  notice: null,
  proposals: [],

  setProject: (projectId) => {
    set((state) =>
      state.projectId === projectId
        ? state
        : {
            projectId,
            messages: [],
            streaming: false,
            activity: null,
            notice: null,
            proposals: [],
          },
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

  addProposal: (proposal) => {
    set((state) => ({
      proposals: [
        ...state.proposals,
        // The turn in flight is the last one, which is where `ask` put it.
        { proposal, messageIndex: Math.max(0, state.messages.length - 1) },
      ],
    }));
  },

  resolveProposal: (id) => {
    set((state) => ({
      proposals: state.proposals.filter((entry) => entry.proposal.id !== id),
    }));
  },

  setActivity: (activity) => {
    set({ activity });
  },

  finish: (reason) => {
    set((state) => {
      const messages = pruneEmptyReply(state.messages);
      return {
        messages,
        proposals: pruneOrphanedProposals(state.proposals, messages.length),
        streaming: false,
        activity: null,
        // "Complete" is the expected outcome and needs no announcement; the
        // other reasons explain a reply that stops looking unfinished.
        notice: reason === "complete" ? null : { kind: "stopped", reason },
      };
    });
  },

  fail: (message) => {
    set((state) => {
      const messages = pruneEmptyReply(state.messages);
      return {
        messages,
        proposals: pruneOrphanedProposals(state.proposals, messages.length),
        streaming: false,
        activity: null,
        notice: { kind: "error", message },
      };
    });
  },

  cancel: () => {
    set((state) => {
      const messages = pruneEmptyReply(state.messages);
      return {
        messages,
        proposals: pruneOrphanedProposals(state.proposals, messages.length),
        streaming: false,
        activity: null,
      };
    });
  },

  clear: () => {
    set({
      messages: [],
      streaming: false,
      activity: null,
      notice: null,
      proposals: [],
    });
  },

  dismissNotice: () => {
    set({ notice: null });
  },
}));
