import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const AI_ENV = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "test-key",
  AI_MODEL: "claude-sonnet-5",
  AI_MAX_TOKENS: 1024,
  AI_REQUESTS_PER_HOUR: 3,
}));

// PROJECTS_ROOT stays real: path confinement resolves against it, and that is
// one of the things under test here.
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/env.js")>();
  return { ...actual, env: { ...actual.env, ...AI_ENV } };
});

const streamMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { stream: streamMock };
  },
}));

const findUnique = vi.hoisted(() => vi.fn());
const buildFileTree = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findUnique } } }));
vi.mock("./fileTreeService.js", () => ({ buildFileTree }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  aiStatus,
  assertWithinAiBudget,
  isAiConfigured,
  prepareTranscript,
  resetAiBudgets,
  streamAssistantReply,
} from "./aiService.js";
import {
  AI_MAX_MESSAGE_CHARS,
  AI_MAX_TRANSCRIPT_CHARS,
  AI_MAX_PROPOSAL_BYTES,
  type AiMessage,
  type AiProposal,
} from "@replit-clone/shared";
import { projectRoot } from "../utils/projectPaths.js";
import { AppError } from "../utils/errors.js";

/** Its own id, not the shared TEST_PROJECT.
 *
 *  This suite creates and deletes a real directory under PROJECTS_DIR, and so
 *  does the file-transfer suite. Vitest runs files in parallel, so sharing an
 *  id means each one's teardown deletes the other's fixtures mid-test. */
const PROJECT = "a1b2c3d4-0000-4000-8000-00000000a1af";
const ROOT = projectRoot(PROJECT);

/** A stand-in for the SDK's MessageStream: emits text, then settles. */
function fakeStream(options: {
  text?: string[];
  stopReason?: string;
  content?: unknown[];
}) {
  const listeners: ((delta: string) => void)[] = [];

  return {
    on(event: string, listener: (delta: string) => void) {
      if (event === "text") listeners.push(listener);
      return this;
    },
    finalMessage() {
      for (const chunk of options.text ?? []) {
        for (const listener of listeners) listener(chunk);
      }
      return Promise.resolve({
        stop_reason: options.stopReason ?? "end_turn",
        content: options.content ?? [],
      });
    },
  };
}

/** A stream whose finalMessage rejects, for the failure paths. */
function rejectingStream(finalMessage: () => Promise<never>) {
  const stub = {
    on: () => stub,
    finalMessage,
  };
  return stub;
}

/** Captures everything a call produced. */
async function ask(
  question = "why is this broken?",
  extra: Partial<Parameters<typeof streamAssistantReply>[0]> = {},
) {
  const deltas: string[] = [];
  const activity: { tool: string; detail: string }[] = [];
  const proposals: AiProposal[] = [];

  const stopReason = await streamAssistantReply({
    projectId: PROJECT,
    messages: [{ role: "user", content: question }],
    signal: new AbortController().signal,
    // The common case. The read-only path says so explicitly.
    canEdit: true,
    onDelta: (text) => deltas.push(text),
    onActivity: (entry) => activity.push(entry),
    onProposal: (proposal) => proposals.push(proposal),
    ...extra,
  });

  return { stopReason, deltas, activity, proposals, text: deltas.join("") };
}

/** The params the SDK was called with on a given round. */
function callParams(round = 0): {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: unknown }[];
  tools: { name: string }[];
} {
  return streamMock.mock.calls[round]?.[0] as ReturnType<typeof callParams>;
}

beforeAll(async () => {
  await fs.mkdir(path.join(ROOT, "src"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "src", "App.tsx"), "export const App = () => null;");
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // reset rather than clear: clearAllMocks leaves queued mockReturnValueOnce
  // implementations in place, so one test's tool-use round would spill into
  // the next and make the suite order-dependent.
  vi.resetAllMocks();
  resetAiBudgets();
  findUnique.mockResolvedValue({ id: PROJECT, name: "demo", template: "react-vite" });
  buildFileTree.mockResolvedValue({
    name: "root",
    relPath: "",
    type: "directory",
    children: [
      { name: "src", relPath: "src", type: "directory", children: [
        { name: "App.tsx", relPath: "src/App.tsx", type: "file" },
      ] },
      { name: "package.json", relPath: "package.json", type: "file" },
    ],
  });
});

describe("configuration", () => {
  it("reports configured with a key present", () => {
    expect(isAiConfigured()).toBe(true);
    expect(aiStatus()).toEqual({ configured: true, model: "claude-sonnet-5" });
  });
});

describe("streamAssistantReply", () => {
  it("streams the reply through onDelta in order", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["Because ", "the port ", "is wrong."] }));

    const { text, stopReason } = await ask();

    expect(text).toBe("Because the port is wrong.");
    expect(stopReason).toBe("complete");
  });

  it("asks the configured model, within the configured token budget", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams()).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 1024,
    });
  });

  /** Two tools: one reads, one offers. Neither writes. */
  it("offers read_file and propose_edit, and nothing else", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams().tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "propose_edit",
    ]);
  });

  it("puts the project's file listing in the system prompt", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    const { system } = callParams();
    expect(system).toContain("src/App.tsx");
    expect(system).toContain("package.json");
    expect(system).toContain("demo");
  });

  /** A model that says "I fixed it" when nothing has been written has lied to
   *  the user about the state of their project. */
  it("tells the model a proposal is not a change", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams().system).toMatch(/waiting for their review/i);
  });

  it("tells the model plainly that it cannot run anything", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams().system).toMatch(/cannot run commands/i);
  });

  it("still answers when the file listing cannot be read", async () => {
    buildFileTree.mockRejectedValue(new Error("ENOENT"));
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    const { stopReason } = await ask();

    expect(stopReason).toBe("complete");
    expect(callParams().system).toContain("could not read the file listing");
  });

  it("refuses an empty conversation", async () => {
    await expect(
      streamAssistantReply({
        projectId: PROJECT,
        messages: [],
        signal: new AbortController().signal,
        canEdit: true,
        onDelta: () => undefined,
        onActivity: () => undefined,
        onProposal: () => undefined,
      }),
    ).rejects.toThrow(AppError);
  });

  it("reports hitting the token ceiling rather than calling it complete", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["half an ans"], stopReason: "max_tokens" }));

    const { stopReason } = await ask();

    expect(stopReason).toBe("max_tokens");
  });
});

describe("editor context", () => {
  it("attaches the open file to the last user turn", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask("what does this do?", {
      context: { relPath: "src/App.tsx", contents: "export const App = () => null;" },
    });

    const last = callParams().messages.at(-1);
    expect(String(last?.content)).toContain("src/App.tsx");
    expect(String(last?.content)).toContain("export const App");
    expect(String(last?.content)).toContain("what does this do?");
  });

  it("attaches a selection when there is one", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask("explain", {
      context: { relPath: "src/App.tsx", selection: "const x = 1;" },
    });

    expect(String(callParams().messages.at(-1)?.content)).toContain("const x = 1;");
  });

  /** It describes what is on screen NOW, so it belongs on the newest turn —
   *  not on the one from when the thread started. */
  it("leaves earlier turns untouched", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await streamAssistantReply({
      projectId: PROJECT,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
      context: { relPath: "src/App.tsx", contents: "x" },
      signal: new AbortController().signal,
      canEdit: true,
      onDelta: () => undefined,
      onActivity: () => undefined,
      onProposal: () => undefined,
    });

    const { messages } = callParams();
    expect(messages[0]?.content).toBe("first");
    expect(String(messages[2]?.content)).toContain("src/App.tsx");
  });

  it("sends nothing extra when no file is open", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask("hello");

    expect(callParams().messages.at(-1)?.content).toBe("hello");
  });
});

describe("the read_file tool", () => {
  const toolUse = (input: unknown, id = "tool-1") => ({
    type: "tool_use",
    id,
    name: "read_file",
    input,
  });

  it("reads a project file and feeds it back to the model", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({ stopReason: "tool_use", content: [toolUse({ path: "src/App.tsx" })] }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["It renders nothing."] }));

    const { text, activity } = await ask();

    expect(text).toBe("It renders nothing.");
    expect(activity).toEqual([{ tool: "read_file", detail: "src/App.tsx" }]);

    // The second round carries the file's contents as a tool_result.
    const results = callParams(1).messages.at(-1)?.content as {
      type: string;
      content: string;
      is_error?: boolean;
    }[];
    expect(results[0]).toMatchObject({ type: "tool_result", is_error: false });
    expect(results[0]?.content).toContain("export const App");
  });

  /** The same choke point the editor and the upload endpoint use. A traversal
   *  comes back to the model as an error, not as somebody else's file. */
  it.each([
    ["a parent traversal", "../../../../etc/passwd"],
    ["a windows traversal", "..\\..\\..\\windows\\win.ini"],
  ])("refuses %s", async (_label, badPath) => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({ stopReason: "tool_use", content: [toolUse({ path: badPath })] }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["I cannot read that."] }));

    await ask();

    const results = callParams(1).messages.at(-1)?.content as {
      content: string;
      is_error?: boolean;
    }[];
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toMatch(/escapes the project/i);
  });

  it("reports a missing file as an error the model can recover from", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({ stopReason: "tool_use", content: [toolUse({ path: "nope.ts" })] }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["Not there."] }));

    const { stopReason } = await ask();

    expect(stopReason).toBe("complete");
    const results = callParams(1).messages.at(-1)?.content as { is_error?: boolean }[];
    expect(results[0]?.is_error).toBe(true);
  });

  it("rejects a call with no path", async () => {
    streamMock
      .mockReturnValueOnce(fakeStream({ stopReason: "tool_use", content: [toolUse({})] }))
      .mockReturnValueOnce(fakeStream({ text: ["done"] }));

    await ask();

    const results = callParams(1).messages.at(-1)?.content as {
      content: string;
      is_error?: boolean;
    }[];
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toMatch(/needs a `path`/);
  });

  it("refuses to read a directory as a file", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({ stopReason: "tool_use", content: [toolUse({ path: "src" })] }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["done"] }));

    await ask();

    const results = callParams(1).messages.at(-1)?.content as {
      content: string;
      is_error?: boolean;
    }[];
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toMatch(/is a directory/);
  });

  it("handles several reads in one round", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({
          stopReason: "tool_use",
          content: [
            toolUse({ path: "src/App.tsx" }, "a"),
            toolUse({ path: "package.json" }, "b"),
          ],
        }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["done"] }));

    const { activity } = await ask();

    expect(activity).toHaveLength(2);
    const results = callParams(1).messages.at(-1)?.content as { tool_use_id: string }[];
    expect(results.map((entry) => entry.tool_use_id)).toEqual(["a", "b"]);
  });

  it("tells the model when it invents a tool", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "x", name: "write_file", input: {} }],
        }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["sorry"] }));

    await ask();

    const results = callParams(1).messages.at(-1)?.content as {
      content: string;
      is_error?: boolean;
    }[];
    expect(results[0]?.is_error).toBe(true);
    expect(results[0]?.content).toMatch(/Unknown tool/);
  });

  /** A model going in circles gets stopped, and the user keeps the partial
   *  answer rather than an open tab. */
  it("stops after the tool-round ceiling", async () => {
    streamMock.mockReturnValue(
      fakeStream({ stopReason: "tool_use", content: [toolUse({ path: "src/App.tsx" })] }),
    );

    const { stopReason } = await ask();

    expect(stopReason).toBe("max_rounds");
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(8);
  });
});

describe("the propose_edit tool", () => {
  const propose = (input: unknown, id = "tool-1") => ({
    type: "tool_use",
    id,
    name: "propose_edit",
    input,
  });

  /** Reads the tool_result the model was handed for the call. */
  function toolResult(round = 1): { content: string; is_error?: boolean } {
    const results = callParams(round).messages.at(-1)?.content as {
      content: string;
      is_error?: boolean;
    }[];
    return results[0] ?? { content: "" };
  }

  function proposing(input: unknown): void {
    streamMock
      .mockReturnValueOnce(
        fakeStream({ stopReason: "tool_use", content: [propose(input)] }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["Have a look."] }));
  }

  const GOOD = { path: "src/App.tsx", contents: "export const App = () => <p />;", summary: "render something" };

  it("hands the proposal out for review", async () => {
    proposing(GOOD);

    const { proposals } = await ask();

    expect(proposals).toEqual([
      expect.objectContaining({
        relPath: "src/App.tsx",
        contents: "export const App = () => <p />;",
        summary: "render something",
      }),
    ]);
  });

  /** The browser resolves one card at a time, and a reply may carry several. */
  it("gives each proposal an id of its own", async () => {
    streamMock
      .mockReturnValueOnce(
        fakeStream({
          stopReason: "tool_use",
          content: [propose(GOOD), propose(GOOD, "tool-2")],
        }),
      )
      .mockReturnValueOnce(fakeStream({ text: ["Two of them."] }));

    const { proposals } = await ask();

    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.id).not.toBe(proposals[1]?.id);
  });

  /** THE guarantee. A tool that wrote would make the review step decorative. */
  it("writes nothing to the file", async () => {
    proposing(GOOD);

    await ask();

    const onDisk = await fs.readFile(path.join(ROOT, "src", "App.tsx"), "utf8");
    expect(onDisk).toBe("export const App = () => null;");
  });

  /** A model told "done" tells the user the change is made. It is not. */
  it("tells the model the change is waiting, not made", async () => {
    proposing(GOOD);

    await ask();

    expect(toolResult().is_error).toBeFalsy();
    expect(toolResult().content).toMatch(/nothing has been written/i);
  });

  it("reports the file it touched, for the activity line", async () => {
    proposing(GOOD);

    const { activity } = await ask();

    expect(activity).toEqual([{ tool: "propose_edit", detail: "src/App.tsx" }]);
  });

  /* --------------------------------------------------------- what it refuses */

  it.each([
    ["a parent traversal", "../../../../etc/passwd"],
    ["a windows traversal", "..\\..\\..\\windows\\win.ini"],
  ])("refuses %s", async (_label, badPath) => {
    proposing({ ...GOOD, path: badPath });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().is_error).toBe(true);
  });

  /** propose_edit replaces a file. Offering to "replace" one that is not there
   *  would create it, and the diff would have nothing to show on the left. */
  it("refuses a file that does not exist", async () => {
    proposing({ ...GOOD, path: "src/Nope.tsx" });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().content).toMatch(/does not exist/i);
  });

  it("refuses a directory", async () => {
    proposing({ ...GOOD, path: "src" });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().content).toMatch(/is a directory/i);
  });

  it("refuses a call with no path", async () => {
    proposing({ contents: "x", summary: "y" });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().is_error).toBe(true);
  });

  /** Without this the file is replaced by the word "undefined". */
  it("refuses a call with no contents", async () => {
    proposing({ path: "src/App.tsx", summary: "y" });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().content).toMatch(/contents/i);
  });

  it("refuses a proposal larger than the ceiling", async () => {
    proposing({ ...GOOD, contents: "x".repeat(AI_MAX_PROPOSAL_BYTES + 1) });

    const { proposals } = await ask();

    expect(proposals).toEqual([]);
    expect(toolResult().content).toMatch(/too large/i);
  });

  /** The one that would destroy work. A file the assistant could only ever see
   *  TRUNCATED is one whose tail is missing from anything it writes back, so
   *  accepting the proposal would delete the part it never read. */
  it("refuses to replace a file bigger than it can be shown", async () => {
    const big = path.join(ROOT, "big.txt");
    await fs.writeFile(big, "x".repeat(AI_MAX_PROPOSAL_BYTES + 1000));
    proposing({ ...GOOD, path: "big.txt", contents: "just the first bit" });

    const { proposals } = await ask();

    await fs.rm(big, { force: true });

    expect(proposals).toEqual([]);
    expect(toolResult().content).toMatch(/never saw/i);
  });

  it("falls back to a plain summary rather than refusing over one", async () => {
    proposing({ path: "src/App.tsx", contents: "x" });

    const { proposals } = await ask();

    expect(proposals[0]?.summary).toBeTruthy();
  });

  /* ------------------------------------------------------------- for viewers */

  describe("for a user with read-only access", () => {
    const readOnly = { canEdit: false };

    it("is not offered at all", async () => {
      streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

      await ask("what does this do?", readOnly);

      expect(callParams().tools.map((tool) => tool.name)).toEqual(["read_file"]);
    });

    it("says so in the system prompt rather than leaving it to be discovered", async () => {
      streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

      await ask("what does this do?", readOnly);

      expect(callParams().system).toMatch(/read-only access/i);
    });

    /** A tool it was never given is a tool it cannot be talked into using: the
     *  decision is made here, not in the prompt. */
    it("does nothing when the model calls it anyway", async () => {
      proposing(GOOD);

      const { proposals } = await ask("change it", readOnly);

      expect(proposals).toEqual([]);
      expect(toolResult().content).toMatch(/unknown tool/i);
    });
  });
});

describe("cancellation", () => {
  it("reports cancelled without ever calling the model", async () => {
    const controller = new AbortController();
    controller.abort();

    const stopReason = await streamAssistantReply({
      projectId: PROJECT,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      canEdit: true,
      onDelta: () => undefined,
      onActivity: () => undefined,
      onProposal: () => undefined,
    });

    expect(stopReason).toBe("cancelled");
    expect(streamMock).not.toHaveBeenCalled();
  });

  /** An abort mid-flight is the user's decision, not a failure — they keep
   *  whatever already streamed. */
  it("treats a rejection after an abort as cancelled, not an error", async () => {
    const controller = new AbortController();

    streamMock.mockReturnValue(
      rejectingStream(() => {
        controller.abort();
        return Promise.reject(new Error("Request was aborted"));
      }),
    );

    const stopReason = await streamAssistantReply({
      projectId: PROJECT,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      canEdit: true,
      onDelta: () => undefined,
      onActivity: () => undefined,
      onProposal: () => undefined,
    });

    expect(stopReason).toBe("cancelled");
  });

  it("still surfaces a real failure", async () => {
    streamMock.mockReturnValue(
      rejectingStream(() => Promise.reject(new Error("529 overloaded"))),
    );

    await expect(ask()).rejects.toThrow("529 overloaded");
  });
});

describe("assertWithinAiBudget", () => {
  it("allows requests up to the hourly limit", () => {
    for (let i = 0; i < 3; i++) {
      expect(() => assertWithinAiBudget("user-a")).not.toThrow();
    }
  });

  it("refuses the one after, with a 429 saying when to come back", () => {
    for (let i = 0; i < 3; i++) assertWithinAiBudget("user-a");

    try {
      assertWithinAiBudget("user-a");
      throw new Error("expected the budget to be spent");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe("AI_RATE_LIMITED");
      expect((error as AppError).message).toMatch(/minute/);
    }
  });

  /** Per user, so one person cannot spend the deployment's whole budget. */
  it("counts each user separately", () => {
    for (let i = 0; i < 3; i++) assertWithinAiBudget("user-a");

    expect(() => assertWithinAiBudget("user-b")).not.toThrow();
  });

  it("forgives everyone once the window rolls over", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) assertWithinAiBudget("user-a");
      expect(() => assertWithinAiBudget("user-a")).toThrow();

      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      expect(() => assertWithinAiBudget("user-a")).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The history count was bounded and the message size was not, so one question
 *  could carry as many tokens as the client cared to send. */
describe("transcript limits", () => {
  const long = (chars: number) => "x".repeat(chars);

  it("refuses a question over the per-message ceiling", () => {
    expect(() =>
      prepareTranscript([{ role: "user", content: long(AI_MAX_MESSAGE_CHARS + 1) }]),
    ).toThrow(/too long/i);
  });

  it("keeps a question that just fits", () => {
    const messages: AiMessage[] = [
      { role: "user", content: long(AI_MAX_MESSAGE_CHARS) },
    ];

    expect(prepareTranscript(messages)).toEqual(messages);
  });

  /** Refusing the whole thread over something already answered would strand
   *  the user; the newest turn is the only one they can still edit. */
  it("truncates an oversized earlier turn instead of refusing", () => {
    const kept = prepareTranscript([
      { role: "user", content: long(AI_MAX_MESSAGE_CHARS + 500) },
      { role: "assistant", content: "sure" },
      { role: "user", content: "and now?" },
    ]);

    expect(kept[0]?.content).toContain("[earlier message truncated]");
    expect(kept[0]?.content.length).toBeLessThan(AI_MAX_MESSAGE_CHARS + 100);
  });

  it("drops the oldest turns to fit the whole-transcript budget", () => {
    const each = AI_MAX_MESSAGE_CHARS;
    const turns = Math.ceil(AI_MAX_TRANSCRIPT_CHARS / each) + 3;

    const kept = prepareTranscript(
      Array.from({ length: turns }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `${String(index)}${long(each - 1)}`,
      })),
    );

    const total = kept.reduce((sum, message) => sum + message.content.length, 0);
    expect(total).toBeLessThanOrEqual(AI_MAX_TRANSCRIPT_CHARS);
    // The newest survives: it is the question being asked.
    expect(kept.at(-1)?.content.startsWith(String(turns - 1))).toBe(true);
    expect(kept.length).toBeLessThan(turns);
  });

  /** Everything here arrives over a socket, so the shape is not a given. */
  it("refuses a conversation that is not messages at all", () => {
    expect(() =>
      prepareTranscript([{ role: "user", content: 42 } as unknown as AiMessage]),
    ).toThrow(/shape/i);
    expect(() =>
      prepareTranscript([{ role: "system", content: "x" } as unknown as AiMessage]),
    ).toThrow(/shape/i);
  });

  it("stops an oversized question before the model is called", async () => {
    streamMock.mockClear();

    await expect(
      streamAssistantReply({
        projectId: PROJECT,
        messages: [{ role: "user", content: long(AI_MAX_MESSAGE_CHARS + 1) }],
        signal: new AbortController().signal,
        canEdit: true,
        onDelta: () => undefined,
        onActivity: () => undefined,
        onProposal: () => undefined,
      }),
    ).rejects.toThrow(AppError);

    expect(streamMock).not.toHaveBeenCalled();
  });
});
