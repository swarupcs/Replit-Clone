import { beforeEach, describe, expect, it, vi } from "vitest";

const aiService = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  assertWithinAiBudget: vi.fn(),
  streamAssistantReply: vi.fn(),
}));

vi.mock("../service/aiService.js", () => aiService);

/** The handler resolves the asking account's hourly allowance before spending
 *  against it. Mocked rather than left to reach the database, which in this
 *  file is not configured — the real one would fail open to the free plan
 *  after a two-second timeout, and every assertion here would be racing it. */
vi.mock("../service/entitlementService.js", () => ({
  resolveEntitlements: vi.fn(() =>
    Promise.resolve({ aiRequestsPerHour: 60, planLabel: "Free" }),
  ),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn(), snapshot: vi.fn() }));

import { installAiHandler } from "./aiHandler.js";
import type { EditorSocket } from "./editorHandler.js";
import { AppError } from "../utils/errors.js";
import type { AiAskPayload } from "@replit-clone/shared";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = "11111111-1111-4111-8111-111111111111";

interface Emitted {
  event: string;
  payload: unknown;
}

/** A socket recording what was emitted and letting a test fire client events. */
function fakeSocket(accessLevel = "editor") {
  const handlers = new Map<string, ((payload?: unknown) => void)[]>();
  const emitted: Emitted[] = [];

  const socket = {
    data: { projectId: PROJECT, userId: USER, accessLevel },
    on(event: string, handler: (payload?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return socket;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };

  return {
    socket: socket as unknown as EditorSocket,
    emitted,
    fire(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    events: () => emitted.map((entry) => entry.event),
    payloadFor: (event: string) =>
      emitted.find((entry) => entry.event === event)?.payload,
  };
}

const QUESTION: AiAskPayload = {
  messages: [{ role: "user", content: "why is this broken?" }],
};

/** Lets the handler's async body run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A reply the test finishes by hand.
 *
 *  Timers would do, but a test that returns while a timer is still pending
 *  leaves the handler running after the case is over — which is how one test's
 *  stray work becomes another's mystery failure, and at worst outlives the
 *  whole file. `settleWith` finishes the call AND waits for the handler to
 *  unwind, so each case leaves nothing behind.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return {
    promise,
    async settleWith(value: T): Promise<void> {
      resolve(value);
      await settle();
    },
  };
}

beforeEach(() => {
  // reset rather than clear: clearAllMocks keeps implementations, so a test
  // that makes the budget throw would make every later one throw too.
  vi.resetAllMocks();
  aiService.isAiConfigured.mockReturnValue(true);
  aiService.assertWithinAiBudget.mockImplementation(() => undefined);
  aiService.streamAssistantReply.mockResolvedValue("complete");
});

describe("installAiHandler", () => {
  it("streams a reply and finishes with aiDone", async () => {
    aiService.streamAssistantReply.mockImplementation(
      (options: { onDelta: (t: string) => void }) => {
        options.onDelta("Because ");
        options.onDelta("the port is wrong.");
        return Promise.resolve("complete");
      },
    );

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(harness.events()).toEqual(["aiDelta", "aiDelta", "aiDone"]);
    expect(harness.payloadFor("aiDone")).toEqual({ stopReason: "complete" });
  });

  it("relays tool activity so a pause is legible", async () => {
    aiService.streamAssistantReply.mockImplementation(
      (options: { onActivity: (a: unknown) => void }) => {
        options.onActivity({ tool: "read_file", detail: "src/App.tsx" });
        return Promise.resolve("complete");
      },
    );

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(harness.payloadFor("aiActivity")).toEqual({
      tool: "read_file",
      detail: "src/App.tsx",
    });
  });

  /* ------------------------------------------------------- proposed changes */

  /** Reads the canEdit the service was called with. */
  function askedCanEdit(): boolean {
    return (
      aiService.streamAssistantReply.mock.calls[0]?.[0] as { canEdit: boolean }
    ).canEdit;
  }

  it("relays a proposed change for the user to review", async () => {
    const offer = {
      id: "proposal-1",
      relPath: "src/App.tsx",
      contents: "the new file",
      summary: "fix the thing",
    };
    aiService.streamAssistantReply.mockImplementation(
      (options: { onProposal: (p: unknown) => void }) => {
        options.onProposal(offer);
        return Promise.resolve("complete");
      },
    );

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(harness.payloadFor("aiProposal")).toEqual(offer);
  });

  /** The user stopped this answer. A card outliving it is an offer from a
   *  conversation they already dismissed. */
  it("says nothing about a proposal from a cancelled reply", async () => {
    const reply = deferred<string>();
    aiService.streamAssistantReply.mockImplementation(
      (options: { signal: AbortSignal; onProposal: (p: unknown) => void }) => {
        options.signal.addEventListener("abort", () => {
          options.onProposal({ id: "p-1", relPath: "a.ts", contents: "x", summary: "y" });
        });
        return reply.promise;
      },
    );

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();
    harness.fire("aiCancel");
    await reply.settleWith("cancelled");

    expect(harness.events()).not.toContain("aiProposal");
  });

  it("tells the service this user may change the project", async () => {
    const harness = fakeSocket("editor");
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(askedCanEdit()).toBe(true);
  });

  it("counts an owner as able to change the project", async () => {
    const harness = fakeSocket("owner");
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(askedCanEdit()).toBe(true);
  });

  /** A viewer still gets the assistant — reading and explaining is what
   *  read-only access is for. What they do not get is a tool whose only
   *  purpose is to produce a change they could never apply. */
  it("tells the service a viewer may not", async () => {
    const harness = fakeSocket("viewer");
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(askedCanEdit()).toBe(false);
  });

  it("passes the project and the question through", async () => {
    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", { ...QUESTION, context: { relPath: "a.ts" } });
    await settle();

    expect(aiService.streamAssistantReply).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        messages: QUESTION.messages,
        context: { relPath: "a.ts" },
      }),
    );
  });

  it("spends the asking user's budget, not the project owner's", async () => {
    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    // The allowance passed with it is the ASKING account's plan, for the same
    // reason the identity is: a viewer asking questions in somebody else's
    // project spends their own hour, not the owner's.
    expect(aiService.assertWithinAiBudget).toHaveBeenCalledWith(USER, 60);
  });

  /** The panel is hidden when unconfigured, so this is the belt to that
   *  braces — a stale tab, or a client that asks anyway. */
  it("refuses when no key is configured, without calling the service", async () => {
    aiService.isAiConfigured.mockReturnValue(false);

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(harness.payloadFor("aiError")).toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
    expect(aiService.streamAssistantReply).not.toHaveBeenCalled();
  });

  it("relays a rate-limit refusal with its own message", async () => {
    aiService.assertWithinAiBudget.mockImplementation(() => {
      throw new AppError(429, "AI_RATE_LIMITED", "Try again in 12 minutes.");
    });

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    expect(harness.payloadFor("aiError")).toEqual({
      code: "AI_RATE_LIMITED",
      message: "Try again in 12 minutes.",
    });
    expect(aiService.streamAssistantReply).not.toHaveBeenCalled();
  });

  /** An upstream failure must not leak its message: it can carry a URL, a key
   *  prefix, or a stack. */
  it("reports an unexpected failure generically", async () => {
    aiService.streamAssistantReply.mockRejectedValue(
      new Error("401 invalid x-api-key sk-ant-abc123"),
    );

    const harness = fakeSocket();
    installAiHandler(harness.socket);
    harness.fire("aiAsk", QUESTION);
    await settle();

    const payload = harness.payloadFor("aiError") as { code: string; message: string };
    expect(payload.code).toBe("AI_FAILED");
    expect(payload.message).not.toContain("sk-ant");
    expect(payload.message).not.toContain("401");
  });

describe("cancellation", () => {
    it("aborts the reply in flight", async () => {
      const reply = deferred<string>();
      let seen: AbortSignal | undefined;

      aiService.streamAssistantReply.mockImplementation(
        (options: { signal: AbortSignal }) => {
          seen = options.signal;
          return reply.promise;
        },
      );

      const harness = fakeSocket();
      installAiHandler(harness.socket);
      harness.fire("aiAsk", QUESTION);
      await settle();

      expect(seen?.aborted).toBe(false);
      harness.fire("aiCancel");
      expect(seen?.aborted).toBe(true);

      await reply.settleWith("cancelled");
    });

    /** Whatever streamed already is the user's to keep; sending aiDone after
     *  they pressed stop would reopen a turn they closed. */
    it("says nothing more after a cancel", async () => {
      const reply = deferred<string>();

      aiService.streamAssistantReply.mockImplementation(
        (options: { onDelta: (t: string) => void }) => {
          options.onDelta("partial");
          // A real stream can emit one more chunk before it unwinds, after the
          // user has already pressed stop.
          return reply.promise.then((value) => {
            options.onDelta("should not arrive");
            return value;
          });
        },
      );

      const harness = fakeSocket();
      installAiHandler(harness.socket);
      harness.fire("aiAsk", QUESTION);
      await settle();
      harness.fire("aiCancel");
      await reply.settleWith("cancelled");

      expect(harness.emitted.map((entry) => entry.payload)).toEqual([
        { text: "partial" },
      ]);
      expect(harness.events()).not.toContain("aiDone");
    });

    it("aborts when the socket closes", async () => {
      const reply = deferred<string>();
      let seen: AbortSignal | undefined;

      aiService.streamAssistantReply.mockImplementation(
        (options: { signal: AbortSignal }) => {
          seen = options.signal;
          return reply.promise;
        },
      );

      const harness = fakeSocket();
      installAiHandler(harness.socket);
      harness.fire("aiAsk", QUESTION);
      await settle();
      harness.fire("disconnect");

      expect(seen?.aborted).toBe(true);

      await reply.settleWith("cancelled");
    });

    /** Two streams writing into one transcript interleave into nonsense. */
    it("supersedes an earlier question with a later one", async () => {
      const replies = [deferred<string>(), deferred<string>()];
      const signals: AbortSignal[] = [];

      aiService.streamAssistantReply.mockImplementation(
        (options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          return replies[signals.length - 1]?.promise ?? Promise.resolve("complete");
        },
      );

      const harness = fakeSocket();
      installAiHandler(harness.socket);
      harness.fire("aiAsk", QUESTION);
      await settle();
      harness.fire("aiAsk", QUESTION);
      await settle();

      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);

      await replies[0]?.settleWith("cancelled");
      await replies[1]?.settleWith("complete");
    });

    it("does not report a cancelled request as an error", async () => {
      const reply = deferred<string>();

      aiService.streamAssistantReply.mockImplementation(
        (options: { signal: AbortSignal }) =>
          reply.promise.then((value) => {
            // An aborted upstream call rejects rather than returning.
            if (options.signal.aborted) throw new Error("aborted");
            return value;
          }),
      );

      const harness = fakeSocket();
      installAiHandler(harness.socket);
      harness.fire("aiAsk", QUESTION);
      await settle();
      harness.fire("aiCancel");
      await reply.settleWith("complete");

      expect(harness.events()).not.toContain("aiError");
    });
  });
});
