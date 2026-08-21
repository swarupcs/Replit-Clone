import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Empty, Tooltip, message as antdMessage } from "antd";
import {
  VscClearAll,
  VscCopy,
  VscSend,
  VscSparkle,
  VscStopCircle,
} from "react-icons/vsc";
import type { AiActivity, AiMessage, AiStopReason } from "@replit-clone/shared";
import { useAiChatStore } from "../../../store/aiChatStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
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
 *  Read-only by design: it explains and drafts, and the user applies what they
 *  want. There is deliberately no "apply this change" button — that needs a
 *  diff to approve and an undo to fall back on, and without both the first bad
 *  suggestion silently overwrites someone's work.
 */
export function AiPanel({ projectId, model }: Props) {
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);

  const messages = useAiChatStore((state) => state.messages);
  const streaming = useAiChatStore((state) => state.streaming);
  const activity = useAiChatStore((state) => state.activity);
  const notice = useAiChatStore((state) => state.notice);

  const setProject = useAiChatStore((state) => state.setProject);
  const ask = useAiChatStore((state) => state.ask);
  const clear = useAiChatStore((state) => state.clear);
  const cancel = useAiChatStore((state) => state.cancel);
  const dismissNotice = useAiChatStore((state) => state.dismissNotice);

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

    editorSocket.on("aiDelta", onDelta);
    editorSocket.on("aiActivity", onActivity);
    editorSocket.on("aiDone", onDone);
    editorSocket.on("aiError", onError);

    return () => {
      editorSocket.off("aiDelta", onDelta);
      editorSocket.off("aiActivity", onActivity);
      editorSocket.off("aiDone", onDone);
      editorSocket.off("aiError", onError);
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
                Ask about this project. The assistant can read your files —
                it cannot change them.
              </span>
            }
          />
        )}

        {messages.map((entry, index) => (
          <Bubble
            // Index is a stable key here: messages are only ever appended, and
            // the last one is mutated in place as it streams.
            key={index}
            message={entry}
            streaming={streaming && index === messages.length - 1}
          />
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
