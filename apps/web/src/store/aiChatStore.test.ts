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
    proposals: [],
  });
});

/** A change the assistant is offering. Nothing has been written. */
function offer(id: string, relPath = "src/App.tsx") {
  return { id, relPath, contents: "the new file", summary: "fix the thing" };
}

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

describe("proposals", () => {
  it("files a proposal against the reply that produced it", () => {
    store().ask("fix it");
    store().addProposal(offer("p-1"));

    expect(store().proposals).toEqual([
      { proposal: offer("p-1"), messageIndex: 1 },
    ]);
  });

  /** One reply can offer several changes, and accepting one must not take the
   *  others off the screen. */
  it("resolves exactly the one named", () => {
    store().ask("fix both");
    store().addProposal(offer("p-1", "a.ts"));
    store().addProposal(offer("p-2", "b.ts"));

    store().resolveProposal("p-1");

    expect(store().proposals.map((entry) => entry.proposal.id)).toEqual(["p-2"]);
  });

  it("keeps the cards from a reply that finished", () => {
    store().ask("fix it");
    store().appendDelta("here is one");
    store().addProposal(offer("p-1"));

    store().finish("complete");

    expect(store().proposals).toHaveLength(1);
  });

  /** A reply that offered a change and then failed before writing a word gets
   *  its empty turn pruned. A card left pointing past the end of the transcript
   *  renders under whichever message later takes that index. */
  it("drops cards whose turn was pruned away", () => {
    store().ask("fix it");
    store().addProposal(offer("p-1"));

    store().fail("the assistant fell over");

    expect(store().proposals).toEqual([]);
  });

  it("drops cards when a cancelled reply is pruned away", () => {
    store().ask("fix it");
    store().addProposal(offer("p-1"));

    store().cancel();

    expect(store().proposals).toEqual([]);
  });

  it("forgets every offer when the conversation is cleared", () => {
    store().ask("fix it");
    store().appendDelta("done");
    store().addProposal(offer("p-1"));

    store().clear();

    expect(store().proposals).toEqual([]);
  });

  /** An offer is about a file in a specific project. */
  it("forgets every offer when the project changes", () => {
    store().setProject("p1");
    store().ask("fix it");
    store().appendDelta("done");
    store().addProposal(offer("p-1"));

    store().setProject("p2");

    expect(store().proposals).toEqual([]);
  });
});
