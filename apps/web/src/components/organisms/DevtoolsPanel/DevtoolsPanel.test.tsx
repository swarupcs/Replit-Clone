// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BridgeRecord, ErrorRecord } from "@replit-clone/shared";
import { DevtoolsPanel, PreviewErrorOverlay } from "./DevtoolsPanel.tsx";
import { useDevtoolsStore } from "../../../store/devtoolsStore.ts";

/** §13.5's panel. The row's sharpest user "cannot open devtools on somebody
 *  else's page and would not know to", so what matters is that the information
 *  is visible here without anybody being told to press F12. */

function log(text: string, level: "log" | "error" = "log"): BridgeRecord {
  return { kind: "console", level, text, at: Date.parse("2026-09-11T01:00:00Z") };
}

function failure(message: string): ErrorRecord {
  return {
    kind: "error",
    message,
    source: "http://preview/app.js",
    line: 12,
    column: 3,
    stack: "TypeError: x is not a function\n  at app.js:12",
    rejection: false,
    at: Date.parse("2026-09-11T01:00:00Z"),
  };
}

beforeEach(() => {
  useDevtoolsStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe("the console tab", () => {
  it("shows what the preview logged", () => {
    useDevtoolsStore.getState().record(log("hello from the app"));
    render(<DevtoolsPanel />);

    expect(screen.getByText("hello from the app")).toBeTruthy();
  });

  it("says so when nothing has been logged yet", () => {
    render(<DevtoolsPanel />);
    expect(screen.getByText(/Nothing logged yet/)).toBeTruthy();
  });

  it("reports how many records were dropped", () => {
    // Better than quietly showing the last 500 as if they were all of them.
    useDevtoolsStore.setState({ dropped: 1234 });
    render(<DevtoolsPanel />);

    expect(screen.getByText(/1,234 dropped/)).toBeTruthy();
  });

  it("clears on request", () => {
    useDevtoolsStore.getState().record(log("transient"));
    render(<DevtoolsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.queryByText("transient")).toBeNull();
  });
});

describe("the error overlay", () => {
  it("puts the newest error over the preview", () => {
    // Over it rather than in a tab: a blank iframe with the explanation filed
    // under a tab nobody opened is the situation §13.5 describes.
    useDevtoolsStore.getState().record(failure("x is not a function"));
    render(<PreviewErrorOverlay onDismiss={() => undefined} />);

    expect(screen.getByText("Runtime error")).toBeTruthy();
    expect(screen.getByText("x is not a function")).toBeTruthy();
  });

  it("names an unhandled rejection as one", () => {
    useDevtoolsStore.getState().record({ ...failure("nope"), rejection: true });
    render(<PreviewErrorOverlay onDismiss={() => undefined} />);

    expect(screen.getByText("Unhandled promise rejection")).toBeTruthy();
  });

  it("shows nothing when the preview has not failed", () => {
    const { container } = render(<PreviewErrorOverlay onDismiss={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays dismissed for the error it was dismissed for", () => {
    useDevtoolsStore.getState().record(failure("x is not a function"));
    render(<PreviewErrorOverlay onDismiss={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Runtime error")).toBeNull();
  });

  it("comes back for a NEW error after one was dismissed", async () => {
    // Dismissing "I have seen this one" must not mean "stop telling me".
    useDevtoolsStore.getState().record(failure("first"));
    render(<PreviewErrorOverlay onDismiss={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    useDevtoolsStore.getState().record({ ...failure("second"), at: Date.now() + 1000 });

    await waitFor(() => {
      expect(screen.getByText("second")).toBeTruthy();
    });
  });
});
