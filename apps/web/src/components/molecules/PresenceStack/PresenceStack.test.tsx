// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PresenceStack } from "./PresenceStack.tsx";
import { usePresenceStore } from "../../../store/presenceStore.ts";
import type { Peer } from "../../../lib/collab.ts";

function peer(name: string, files = ["src/App.tsx"]): Peer {
  return { key: name, name, color: "hsl(200 70% 62%)", files };
}

beforeEach(() => {
  usePresenceStore.setState({ peers: [], colorsByFile: {} });
});

afterEach(() => {
  cleanup();
});

describe("PresenceStack", () => {
  it("shows nothing at all when nobody else is here", () => {
    const { container } = render(<PresenceStack />);

    // Not an empty circle or a "0" — a solo project should look solo.
    expect(container.firstChild).toBeNull();
  });

  it("names each person, rather than relying on their colour", () => {
    usePresenceStore.getState().setPresence([peer("ana@example.com")]);
    render(<PresenceStack />);

    // The face is a button now — it toggles following — so its accessible
    // name says what it does as well as who it is. The name is still what
    // this test is about, and it is still in there.
    expect(screen.getByLabelText(/ana@example\.com/)).toBeDefined();
  });

  it("collapses the tail into a count", () => {
    usePresenceStore
      .getState()
      .setPresence(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"].map(
        (name) => peer(name),
      ));
    render(<PresenceStack />);

    expect(screen.getByText("+2")).toBeDefined();
  });
});

describe("the presence store", () => {
  it("indexes the colours by file, for the tree and the tab strip to read", () => {
    usePresenceStore
      .getState()
      .setPresence([
        { ...peer("ana@example.com"), color: "red" },
        { ...peer("bo@example.com", ["src/api.ts"]), color: "blue" },
      ]);

    expect(usePresenceStore.getState().colorsByFile).toEqual({
      "src/App.tsx": "red",
      "src/api.ts": "blue",
    });
  });

  it("joins the colours of several people in one file", () => {
    usePresenceStore
      .getState()
      .setPresence([
        { ...peer("ana@example.com"), color: "red" },
        { ...peer("bo@example.com"), color: "blue" },
      ]);

    expect(usePresenceStore.getState().colorsByFile["src/App.tsx"]).toBe(
      "red,blue",
    );
  });

  it("ignores an update that changes nothing anyone would see", () => {
    const { setPresence } = usePresenceStore.getState();
    setPresence([peer("ana@example.com")]);
    const before = usePresenceStore.getState().peers;

    // Awareness fires for a cursor move as well as for someone arriving, and a
    // cursor move changes nothing here.
    setPresence([peer("ana@example.com")]);

    expect(usePresenceStore.getState().peers).toBe(before);
  });
});
