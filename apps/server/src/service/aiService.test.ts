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
}));

import {
  aiStatus,
  assertWithinAiBudget,
  isAiConfigured,
  resetAiBudgets,
  streamAssistantReply,
} from "./aiService.js";
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

  const stopReason = await streamAssistantReply({
    projectId: PROJECT,
    messages: [{ role: "user", content: question }],
    signal: new AbortController().signal,
    onDelta: (text) => deltas.push(text),
    onActivity: (entry) => activity.push(entry),
    ...extra,
  });

  return { stopReason, deltas, activity, text: deltas.join("") };
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

  /** Read-only is the whole design. One tool, and it reads. */
  it("offers exactly one tool, and it is read_file", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams().tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("puts the project's file listing in the system prompt", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    const { system } = callParams();
    expect(system).toContain("src/App.tsx");
    expect(system).toContain("package.json");
    expect(system).toContain("demo");
  });

  it("tells the model plainly that it cannot change anything", async () => {
    streamMock.mockReturnValue(fakeStream({ text: ["ok"] }));

    await ask();

    expect(callParams().system).toMatch(/cannot edit files/i);
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
        onDelta: () => undefined,
        onActivity: () => undefined,
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
      onDelta: () => undefined,
      onActivity: () => undefined,
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

describe("cancellation", () => {
  it("reports cancelled without ever calling the model", async () => {
    const controller = new AbortController();
    controller.abort();

    const stopReason = await streamAssistantReply({
      projectId: PROJECT,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      onDelta: () => undefined,
      onActivity: () => undefined,
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
      onDelta: () => undefined,
      onActivity: () => undefined,
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
