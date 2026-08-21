import { beforeEach, describe, expect, it } from "vitest";
import { useAiChatStore } from "./aiChatStore.ts";

const store = () => useAiChatStore.getState();

beforeEach(() => {
  useAiChatStore.setState({
    projectId: null,
    messages: [],
    streaming: false,
    activity: null,
    notice: null,
  });
});

describe("setProject", () => {
  it("keeps the thread when the project has not changed", () => {
    store().setProject("p1");
    store().ask("hello");
    store().appendDelta("hi");

    store().setProject("p1");

    expect(store().messages).toHaveLength(2);
  });

  /** Opening another project must not inherit the last one's conversation —
   *  the transcript is about a specific set of files. */
  it("clears everything when it changes", () => {
    store().setProject("p1");
    store().ask("hello");
    store().appendDelta("hi");

    store().setProject("p2");

    expect(store()).toMatchObject({
      projectId: "p2",
      messages: [],
      streaming: false,
      activity: null,
    });
  });
});

describe("ask", () => {
  it("records the question and opens an empty turn to stream into", () => {
    store().ask("why?");

    expect(store().messages).toEqual([
      { role: "user", content: "why?" },
      { role: "assistant", content: "" },
    ]);
    expect(store().streaming).toBe(true);
  });

  it("clears a notice left over from the previous reply", () => {
    store().ask("first");
    store().fail("it broke");
    expect(store().notice).not.toBeNull();

    store().ask("second");

    expect(store().notice).toBeNull();
  });
});

describe("appendDelta", () => {
  it("builds the reply up in the last turn", () => {
    store().ask("why?");
    store().appendDelta("Because ");
    store().appendDelta("of the port.");

    expect(store().messages.at(-1)).toEqual({
      role: "assistant",
      content: "Because of the port.",
    });
  });

  /** A late chunk from a stream that has already ended would append to a turn
   *  the user considers finished. */
  it("ignores a chunk that arrives after the reply ended", () => {
    store().ask("why?");
    store().appendDelta("done");
    store().finish("complete");

    store().appendDelta(" extra");

    expect(store().messages.at(-1)?.content).toBe("done");
  });

  it("clears the activity line once text starts arriving", () => {
    store().ask("why?");
    store().setActivity({ tool: "read_file", detail: "a.ts" });

    store().appendDelta("Looking at a.ts,");

    expect(store().activity).toBeNull();
  });
});

describe("finish", () => {
  it("ends the turn silently when the reply completed", () => {
    store().ask("why?");
    store().appendDelta("an answer");

    store().finish("complete");

    expect(store().streaming).toBe(false);
    expect(store().notice).toBeNull();
  });

  it.each([["max_tokens"], ["max_rounds"]] as const)(
    "explains a reply that stopped early (%s)",
    (reason) => {
      store().ask("why?");
      store().appendDelta("half");

      store().finish(reason);

      expect(store().notice).toEqual({ kind: "stopped", reason });
    },
  );

  /** Otherwise an empty bubble sits in the transcript AND travels back as
   *  history on the next question. */
  it("drops an assistant turn that never received a token", () => {
    store().ask("why?");

    store().finish("complete");

    expect(store().messages).toEqual([{ role: "user", content: "why?" }]);
  });

  it("keeps a turn that received even one token", () => {
    store().ask("why?");
    store().appendDelta("x");

    store().finish("complete");

    expect(store().messages).toHaveLength(2);
  });
});

describe("fail", () => {
  it("ends the turn and shows the reason", () => {
    store().ask("why?");

    store().fail("Try again in 12 minutes.");

    expect(store().streaming).toBe(false);
    expect(store().notice).toEqual({
      kind: "error",
      message: "Try again in 12 minutes.",
    });
    expect(store().messages).toEqual([{ role: "user", content: "why?" }]);
  });

  it("keeps whatever streamed before the failure", () => {
    store().ask("why?");
    store().appendDelta("partial");

    store().fail("connection lost");

    expect(store().messages.at(-1)?.content).toBe("partial");
  });
});

describe("cancel", () => {
  /** Stopping is not failing: the user keeps the part they have and is told
   *  nothing they did not already know. */
  it("keeps the partial reply and raises no notice", () => {
    store().ask("why?");
    store().appendDelta("as far as it got");

    store().cancel();

    expect(store().streaming).toBe(false);
    expect(store().notice).toBeNull();
    expect(store().messages.at(-1)?.content).toBe("as far as it got");
  });

  it("removes the turn when nothing had streamed yet", () => {
    store().ask("why?");

    store().cancel();

    expect(store().messages).toEqual([{ role: "user", content: "why?" }]);
  });
});

describe("clear", () => {
  it("empties the transcript and every bit of state around it", () => {
    store().ask("why?");
    store().setActivity({ tool: "read_file", detail: "a.ts" });
    store().fail("broke");

    store().clear();

    expect(store()).toMatchObject({
      messages: [],
      streaming: false,
      activity: null,
      notice: null,
    });
  });
});
