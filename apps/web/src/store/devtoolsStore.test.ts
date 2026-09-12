import { beforeEach, describe, expect, it } from "vitest";
import type { BridgeRecord } from "@replit-clone/shared";
import {
  MAX_CONSOLE,
  MAX_ERRORS,
  MAX_NETWORK,
  selectErrorCount,
  selectLatestError,
  useDevtoolsStore,
} from "./devtoolsStore.ts";

/** The caps are the design here, not a precaution: a `console.log` inside
 *  `requestAnimationFrame` is sixty a second forever, and it is an ordinary
 *  thing to write by accident. */

function log(text: string): BridgeRecord {
  return { kind: "console", level: "log", text, at: 1 };
}

function error(message: string): BridgeRecord {
  return { kind: "error", message, source: undefined, line: undefined, column: undefined, stack: undefined, rejection: false, at: 1 };
}

function request(url: string): BridgeRecord {
  return { kind: "network", method: "GET", url, status: 200, ms: 1, failed: false, at: 1 };
}

beforeEach(() => {
  useDevtoolsStore.getState().clear();
});

describe("what the preview has said", () => {
  it("keeps each feed separately", () => {
    const { record } = useDevtoolsStore.getState();
    record(log("hi"));
    record(error("boom"));
    record(request("/x"));

    const state = useDevtoolsStore.getState();
    expect(state.console).toHaveLength(1);
    expect(state.errors).toHaveLength(1);
    expect(state.network).toHaveLength(1);
  });

  it("caps the console and keeps the NEWEST entries", () => {
    const { record } = useDevtoolsStore.getState();
    for (let i = 0; i < MAX_CONSOLE + 50; i++) record(log(`line ${String(i)}`));

    const state = useDevtoolsStore.getState();
    expect(state.console).toHaveLength(MAX_CONSOLE);
    // The last thing that happened is the thing somebody is looking for.
    expect(state.console.at(-1)?.text).toBe(`line ${String(MAX_CONSOLE + 49)}`);
  });

  it("says how many it dropped rather than quietly lying", () => {
    const { record } = useDevtoolsStore.getState();
    for (let i = 0; i < MAX_CONSOLE + 10; i++) record(log("x"));

    expect(useDevtoolsStore.getState().dropped).toBe(10);
  });

  it("does not let a chatty log push the errors out", () => {
    // Separate budgets, because the errors are the rows somebody needs.
    const { record } = useDevtoolsStore.getState();
    record(error("the one that matters"));
    for (let i = 0; i < MAX_CONSOLE + 200; i++) record(log("noise"));

    expect(useDevtoolsStore.getState().errors).toHaveLength(1);
    expect(useDevtoolsStore.getState().errors[0]?.message).toBe("the one that matters");
  });

  it("caps the network log and the error list too", () => {
    const { record } = useDevtoolsStore.getState();
    for (let i = 0; i < MAX_NETWORK + 5; i++) record(request("/x"));
    for (let i = 0; i < MAX_ERRORS + 5; i++) record(error("boom"));

    expect(useDevtoolsStore.getState().network).toHaveLength(MAX_NETWORK);
    expect(useDevtoolsStore.getState().errors).toHaveLength(MAX_ERRORS);
  });

  it("forgets the previous page on a reload", () => {
    // The last page's console is somebody else's history.
    const { record, clearForReload } = useDevtoolsStore.getState();
    record(log("from the old page"));
    clearForReload();

    expect(useDevtoolsStore.getState().console).toHaveLength(0);
  });

  it("reports the newest error, which is what an overlay should be about", () => {
    const { record } = useDevtoolsStore.getState();
    record(error("first"));
    record(error("second"));

    expect(selectLatestError(useDevtoolsStore.getState())?.message).toBe("second");
    expect(selectErrorCount(useDevtoolsStore.getState())).toBe(2);
  });
});
