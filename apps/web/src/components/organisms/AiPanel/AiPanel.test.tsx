// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AiProposal } from "@replit-clone/shared";
import { AiPanel } from "./AiPanel.tsx";
import { useAiChatStore } from "../../../store/aiChatStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

const PROJECT = "p1";

const OFFER: AiProposal = {
  id: "proposal-1",
  relPath: "src/App.tsx",
  contents: "the assistant's version",
  summary: "handle the empty case",
};

/** Just the parts of the editor socket this panel touches. */
function fakeSocket() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const emitted: { event: string; payload: unknown }[] = [];

  const socket = {
    on(event: string, handler: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    off(event: string, handler: (payload: unknown) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry !== handler),
      );
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };

  return {
    socket,
    emitted,
    /** Delivers a server event, the way the socket would. */
    deliver(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}

let harness: ReturnType<typeof fakeSocket>;

function mount(accessLevel: "owner" | "editor" | "viewer" = "editor") {
  harness = fakeSocket();
  useEditorSocketStore.setState({
    editorSocket: harness.socket as never,
    accessLevel,
  });
  return render(<AiPanel projectId={PROJECT} model="claude-sonnet-5" />);
}

/** Puts a card on screen the way the server does: a question, a reply, an
 *  offer. */
function offerArrives(proposal: AiProposal = OFFER): void {
  // In `act` because these are the store writes the socket makes, and React
  // has to have rendered them before the test looks for a card.
  act(() => {
    useAiChatStore.getState().ask("fix the empty case");
    useAiChatStore.getState().appendDelta("Here is what I would change.");
    harness.deliver("aiProposal", proposal);
  });
}

beforeEach(() => {
  useAiChatStore.setState({
    projectId: PROJECT,
    messages: [],
    streaming: false,
    activity: null,
    notice: null,
    proposals: [],
  });
  useOpenTabsStore.setState({
    tabs: [],
    activeRelPath: null,
    secondaryRelPath: null,
    splitOpen: false,
    focusedPane: "primary",
    pendingReveal: null,
    review: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a change the assistant has offered", () => {
  it("appears as a card naming the file and what it is for", () => {
    mount();
    offerArrives();

    expect(screen.getByText("handle the empty case")).toBeDefined();
    expect(screen.getByText("src/App.tsx")).toBeDefined();
  });

  /** THE guarantee. Reviewing is the only thing a card can do on its own, and
   *  it puts a diff on screen — it does not touch the file. */
  it("writes nothing when it is opened for review", () => {
    mount();
    offerArrives();

    fireEvent.click(screen.getByLabelText("Review the change to src/App.tsx"));

    expect(harness.emitted.map((entry) => entry.event)).not.toContain("writeFile");
  });

  it("opens the file it is against, so there is something to diff", () => {
    mount();
    offerArrives();

    fireEvent.click(screen.getByLabelText("Review the change to src/App.tsx"));

    expect(harness.emitted).toContainEqual({
      event: "readFile",
      payload: { relPath: "src/App.tsx" },
    });
    expect(useOpenTabsStore.getState().review).toMatchObject({
      id: "proposal-1",
      relPath: "src/App.tsx",
      contents: "the assistant's version",
    });
  });

  /** Re-reading a file that is already open would throw away whatever has been
   *  typed since — which is exactly the work the review exists to protect. */
  it("leaves an already-open file alone", () => {
    mount();
    act(() => {
      useOpenTabsStore.getState().openTab("src/App.tsx", "what the user has now");
    });
    offerArrives();

    fireEvent.click(screen.getByLabelText("Review the change to src/App.tsx"));

    expect(harness.emitted.map((entry) => entry.event)).not.toContain("readFile");
    expect(useOpenTabsStore.getState().review).not.toBeNull();
  });

  it("goes away when it is discarded, without opening anything", () => {
    mount();
    offerArrives();

    fireEvent.click(screen.getByLabelText("Discard the change to src/App.tsx"));

    expect(screen.queryByText("handle the empty case")).toBeNull();
    expect(useOpenTabsStore.getState().review).toBeNull();
    expect(harness.emitted).toEqual([]);
  });

  /** One reply can offer several, and discarding one is not discarding both. */
  it("leaves the other cards alone", () => {
    mount();
    offerArrives();
    act(() => {
      harness.deliver("aiProposal", { ...OFFER, id: "proposal-2", relPath: "b.ts" });
    });

    fireEvent.click(screen.getByLabelText("Discard the change to src/App.tsx"));

    expect(screen.getByText("b.ts")).toBeDefined();
  });

  /** The server does not offer a viewer the tool at all; this is the second
   *  half of the same answer, for a level that changed while the panel was
   *  open. */
  it("cannot be reviewed by someone with read-only access", () => {
    mount("viewer");
    offerArrives();

    const button = screen.getByLabelText("Review the change to src/App.tsx");

    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
