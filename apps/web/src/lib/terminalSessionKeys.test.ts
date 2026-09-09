// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetTerminalSession,
  hasTerminalSession,
  terminalSessionKey,
} from "./terminalSessionKeys.ts";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("naming a terminal so a reconnect can find it", () => {
  it("gives one terminal the same key every time it is asked", () => {
    // The whole point: a reload of this tab asks again and must get the key
    // the server is holding a shell under.
    expect(terminalSessionKey(PROJECT, 1)).toBe(terminalSessionKey(PROJECT, 1));
  });

  it("gives different terminals different keys", () => {
    // Otherwise terminal 2 would reconnect to terminal 1's shell and take the
    // pty from it.
    expect(terminalSessionKey(PROJECT, 1)).not.toBe(
      terminalSessionKey(PROJECT, 2),
    );
  });

  it("gives different projects different keys", () => {
    expect(terminalSessionKey(PROJECT, 1)).not.toBe(
      terminalSessionKey("other-project", 1),
    );
  });

  it("mints a key the server will accept", () => {
    // `isValidClientKey` on the server: [A-Za-z0-9_-]{8,64}. A key it rejects
    // is a terminal that silently stops surviving disconnects.
    expect(terminalSessionKey(PROJECT, 1)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("survives a reload, which is the case it exists for", () => {
    const before = terminalSessionKey(PROJECT, 1);

    // A reload keeps sessionStorage and rebuilds every module around it.
    expect(window.sessionStorage.length).toBeGreaterThan(0);
    expect(terminalSessionKey(PROJECT, 1)).toBe(before);
  });
});

describe("forgetting a terminal", () => {
  it("is how a deliberate close is told from a lost connection", () => {
    terminalSessionKey(PROJECT, 1);
    expect(hasTerminalSession(PROJECT, 1)).toBe(true);

    forgetTerminalSession(PROJECT, 1);

    // `BrowserTerminal`'s teardown reads exactly this: gone means the user
    // closed the pane and the server should end the shell now, present means
    // the pane went for some other reason and the shell should be held.
    expect(hasTerminalSession(PROJECT, 1)).toBe(false);
  });

  it("leaves the other terminals alone", () => {
    terminalSessionKey(PROJECT, 1);
    const second = terminalSessionKey(PROJECT, 2);

    forgetTerminalSession(PROJECT, 1);

    expect(hasTerminalSession(PROJECT, 2)).toBe(true);
    expect(terminalSessionKey(PROJECT, 2)).toBe(second);
  });

  it("mints a new key next time, rather than reviving the old one", () => {
    const before = terminalSessionKey(PROJECT, 1);
    forgetTerminalSession(PROJECT, 1);

    // The old session is being ended on the server; asking for it again would
    // reconnect to a shell that is on its way out.
    expect(terminalSessionKey(PROJECT, 1)).not.toBe(before);
  });
});

describe("a browser that refuses storage", () => {
  /** A private window, site data blocked, or a third-party frame — all of
   *  which make `sessionStorage` throw rather than return null. */
  function refuseStorage(): void {
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
  }

  it("still names the terminal, so it still works for this page's life", () => {
    refuseStorage();

    const key = terminalSessionKey(PROJECT, 1);

    // Degrading is the right answer: refusing to open a terminal because it
    // cannot be named would trade a working feature for a missing one. A
    // dropped socket still reconnects; only a reload does not.
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(terminalSessionKey(PROJECT, 1)).toBe(key);
  });

  it("can still be forgotten, so a deliberate close still ends the shell", () => {
    refuseStorage();
    terminalSessionKey(PROJECT, 1);

    forgetTerminalSession(PROJECT, 1);

    expect(hasTerminalSession(PROJECT, 1)).toBe(false);
  });
});
