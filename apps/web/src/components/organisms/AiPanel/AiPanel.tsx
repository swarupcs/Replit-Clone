import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Empty, Tooltip, message as antdMessage } from "antd";
import {
  VscClearAll,
  VscCopy,
  VscDiff,
  VscSend,
  VscSparkle,
  VscStopCircle,
} from "react-icons/vsc";
import type {
  AiActivity,
  AiMessage,
  AiProposal,
  AiStopReason,
} from "@replit-clone/shared";
import { useAiChatStore } from "../../../store/aiChatStore.ts";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { currentEditorContext } from "../../../lib/editorContext.ts";
import { parseSegments } from "./markdown.ts";

interface Props {
  projectId: string;
  /** Shown in the header so which model answers is never a mystery. */
  model: string;
}

const STOP_COPY: Record<string, string> = {
  cancelled: "Stopped.",
  max_tokens: "The reply hit the length limit. Ask for the rest, or narrow the question.",
  max_rounds: "The assistant spent its file-reading budget on this one. The answer above may be incomplete.",
};

/** The project assistant.
 *
 *  It explains and drafts, and it can OFFER a change — but it never makes one.
 *  A proposal arrives as a card here; opening it shows the assistant's version
 *  against the buffer in the editor's diff, and applying it goes through the
 *  editor's own undo stack. The diff and the undo are what this waited for:
 *  without both, the first bad suggestion silently overwrites someone's work.
 */
export function AiPanel({ projectId, model }: Props) {
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const messages = useAiChatStore((state) => state.messages);
  const streaming = useAiChatStore((state) => state.streaming);
  const activity = useAiChatStore((state) => state.activity);
  const notice = useAiChatStore((state) => state.notice);
  const proposals = useAiChatStore((state) => state.proposals);

  const setProject = useAiChatStore((state) => state.setProject);
  const ask = useAiChatStore((state) => state.ask);
  const clear = useAiChatStore((state) => state.clear);
  const cancel = useAiChatStore((state) => state.cancel);
  const dismissNotice = useAiChatStore((state) => state.dismissNotice);

  const canEdit = useEditorSocketStore(selectCanEdit);
  const resolveProposal = useAiChatStore((state) => state.resolveProposal);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setProject(projectId);
  }, [projectId, setProject]);

  // Server events drive the transcript. Registered against the store's actions
  // rather than closing over `messages`, so the listeners never go stale.
  useEffect(() => {
    if (!editorSocket) return;

    const store = useAiChatStore.getState;

    const onDelta = ({ text }: { text: string }) => {
      store().appendDelta(text);
    };
    const onActivity = (next: AiActivity) => {
      store().setActivity(next);
    };
    const onDone = ({ stopReason }: { stopReason: AiStopReason }) => {
      store().finish(stopReason);
    };
    const onError = ({ message }: { code: string; message: string }) => {
      store().fail(message);
    };
    const onProposal = (proposal: AiProposal) => {
      store().addProposal(proposal);
    };

    editorSocket.on("aiDelta", onDelta);
    editorSocket.on("aiActivity", onActivity);
    editorSocket.on("aiDone", onDone);
    editorSocket.on("aiError", onError);
    editorSocket.on("aiProposal", onProposal);

    return () => {
      editorSocket.off("aiDelta", onDelta);
      editorSocket.off("aiActivity", onActivity);
      editorSocket.off("aiDone", onDone);
      editorSocket.off("aiError", onError);
      editorSocket.off("aiProposal", onProposal);
    };
  }, [editorSocket]);

  /** Pinned to the bottom while a reply streams in. */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, activity]);

  const contextLabel = useMemo(() => {
    // Read on every render so the chip tracks the editor, not the last send.
    const context = currentEditorContext();
    if (!context?.relPath) return null;
    return context.selection ? `${context.relPath} (selection)` : context.relPath;
    // messages is in the deps so the chip refreshes as the conversation moves,
    // which is the closest thing to an editor-changed signal this panel has.
  }, [messages, streaming]);

  const send = useCallback(() => {
    const question = draft.trim();
    if (!question || !editorSocket || streaming) return;

    const context = currentEditorContext();

    ask(question);
    setDraft("");

    // The history that travels is the store's, taken AFTER `ask` so it includes
    // this question. The empty assistant turn `ask` opened is dropped: it is a
    // placeholder for the UI, and an empty turn is not a valid message to send.
    const history = useAiChatStore
      .getState()
      .messages.filter((entry: AiMessage) => entry.content !== "");

    editorSocket.emit("aiAsk", {
      messages: history,
      ...(context ? { context } : {}),
    });
  }, [draft, editorSocket, streaming, ask]);

  /** Opens a proposal in the editor's diff.
   *
   *  The file has to be showing for there to be a buffer to compare against.
   *  One that is already open is left exactly as it is — re-reading it from the
   *  server would throw away anything typed since, which is precisely the work
   *  the review exists to protect. */
  const review = useCallback(
    (proposal: AiProposal) => {
      const tabs = useOpenTabsStore.getState();

      if (!tabs.tabs.some((tab) => tab.relPath === proposal.relPath)) {
        editorSocket?.emit("readFile", { relPath: proposal.relPath });
      }

      tabs.startReview({
        id: proposal.id,
        relPath: proposal.relPath,
        summary: proposal.summary,
        contents: proposal.contents,
      });
    },
    [editorSocket],
  );

  const stop = useCallback(() => {
    editorSocket?.emit("aiCancel");
    cancel();
  }, [editorSocket, cancel]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="rc-pane-label" style={{ justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <VscSparkle size={13} />
          <span>Assistant</span>
        </span>

        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontSize: 10.5,
              color: "var(--rc-text-muted)",
              fontFamily: "var(--rc-mono)",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {model}
          </span>
          <Tooltip title="Clear conversation">
            <button
              className="rc-icon-button"
              aria-label="Clear conversation"
              onClick={clear}
              disabled={messages.length === 0}
            >
              <VscClearAll size={14} />
            </button>
          </Tooltip>
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px" }}
      >
        {messages.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            styles={{ image: { height: 40 } }}
            description={
              <span style={{ color: "var(--rc-text-muted)", fontSize: 12.5 }}>
                Ask about this project. The assistant reads your files, and
                can offer a change for you to review — it never makes one.
              </span>
            }
          />
        )}

        {messages.map((entry, index) => (
          <div key={index}>
            <Bubble
              // Index is a stable key here: messages are only ever appended,
              // and the last one is mutated in place as it streams.
              message={entry}
              streaming={streaming && index === messages.length - 1}
            />
            {proposals
              .filter((pending) => pending.messageIndex === index)
              .map((pending) => (
                <ProposalCard
                  key={pending.proposal.id}
                  proposal={pending.proposal}
                  canEdit={canEdit}
                  onReview={review}
                  onDiscard={resolveProposal}
                />
              ))}
          </div>
        ))}

        {activity && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              margin: "2px 0 10px",
              fontSize: 12,
              color: "var(--rc-text-muted)",
              fontFamily: "var(--rc-mono)",
            }}
          >
            <span className="rc-pulse-dot" aria-hidden />
            Reading {activity.detail}
          </div>
        )}
      </div>

      {notice && (
        <Alert
          banner
          closable
          type={notice.kind === "error" ? "error" : "warning"}
          onClose={dismissNotice}
          message={
            notice.kind === "error"
              ? notice.message
              : (STOP_COPY[notice.reason] ?? "The reply ended early.")
          }
          style={{ fontSize: 12 }}
        />
      )}

      <div
        style={{
          borderTop: "1px solid var(--rc-border)",
          padding: "8px 10px 10px",
          flex: "none",
        }}
      >
        {contextLabel && (
          <div
            style={{
              fontSize: 11,
              color: "var(--rc-text-muted)",
              fontFamily: "var(--rc-mono)",
              marginBottom: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`${contextLabel} is sent with your question`}
          >
            ↳ {contextLabel}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            className="rc-chat-input"
            rows={2}
            value={draft}
            placeholder="Ask about your code…"
            aria-label="Ask the assistant"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline, the way every chat box
              // behaves. Without the guard a multi-line question is impossible.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />

          {streaming ? (
            <Tooltip title="Stop">
              <button className="rc-icon-button" aria-label="Stop" onClick={stop}>
                <VscStopCircle size={16} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip title="Send (Enter)">
              <button
                className="rc-icon-button"
                aria-label="Send"
                onClick={send}
                disabled={draft.trim() === "" || !editorSocket}
              >
                <VscSend size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/** One offered change, before anybody has looked at it.
 *
 *  Says which file and what for, and stops there. The decision belongs in front
 *  of the diff, not in front of a one-line summary, so the only affordance that
 *  leads anywhere is the one that opens it. */
function ProposalCard({
  proposal,
  canEdit,
  onReview,
  onDiscard,
}: {
  proposal: AiProposal;
  canEdit: boolean;
  onReview: (proposal: AiProposal) => void;
  onDiscard: (id: string) => void;
}) {
  return (
    <div className="rc-proposal-card">
      <span className="rc-proposal-text">
        {proposal.summary}
        <span className="rc-proposal-path" title={proposal.relPath}>
          {proposal.relPath}
        </span>
      </span>

      <button
        className="rc-review-button"
        onClick={() => onDiscard(proposal.id)}
        aria-label={`Discard the change to ${proposal.relPath}`}
      >
        Discard
      </button>
      <Tooltip
        title={
          canEdit
            ? "See it against your file before anything is applied"
            : "You have read-only access to this project"
        }
      >
        <button
          className="rc-review-button"
          data-primary
          disabled={!canEdit}
          onClick={() => onReview(proposal)}
          aria-label={`Review the change to ${proposal.relPath}`}
        >
          <VscDiff size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Review
        </button>
      </Tooltip>
    </div>
  );
}

function Bubble({ message, streaming }: { message: AiMessage; streaming: boolean }) {
  const isUser = message.role === "user";
  const segments = useMemo(
    () => (isUser ? [] : parseSegments(message.content)),
    [isUser, message.content],
  );

  if (isUser) {
    return (
      <div style={{ margin: "0 0 12px", display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "88%",
            background: "var(--rc-surface-raised)",
            border: "1px solid var(--rc-border)",
            borderRadius: 10,
            padding: "7px 10px",
            fontSize: 13,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: "0 0 14px" }}>
      {message.content === "" && streaming ? (
        <span className="rc-pulse-dot" aria-label="Thinking" />
      ) : (
        segments.map((segment, index) =>
          segment.kind === "code" ? (
            <CodeBlock key={index} code={segment.content} language={segment.language} />
          ) : (
            <p
              key={index}
              style={{
                margin: "0 0 8px",
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {segment.content}
            </p>
          ),
        )
      )}
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(
      () => antdMessage.success("Copied"),
      () => antdMessage.error("Could not copy"),
    );
  }, [code]);

  return (
    <div
      style={{
        border: "1px solid var(--rc-border)",
        borderRadius: 8,
        margin: "0 0 10px",
        overflow: "hidden",
        background: "var(--rc-surface-sunken)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "3px 4px 3px 9px",
          borderBottom: "1px solid var(--rc-border)",
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: "var(--rc-text-muted)",
            fontFamily: "var(--rc-mono)",
          }}
        >
          {language ?? "code"}
        </span>
        <Tooltip title="Copy">
          <button className="rc-icon-button" aria-label="Copy code" onClick={copy}>
            <VscCopy size={13} />
          </button>
        </Tooltip>
      </div>

      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          overflowX: "auto",
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: "var(--rc-mono)",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
