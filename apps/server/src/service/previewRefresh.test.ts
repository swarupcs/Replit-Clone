import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRunState = vi.hoisted(() => vi.fn(() => ({ status: "idle" })));

vi.mock("../containers/runner.js", () => ({ getRunState }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  createPreviewAnnouncer,
  createPreviewHealthAnnouncer,
} from "./previewRefresh.js";
import {
  hasLiveHmr,
  noteHmrClosed,
  noteHmrOpen,
  resetHmrSockets,
} from "./hmrSockets.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A stand-in namespace that records room broadcasts. */
function makeNamespace() {
  const roomEmits: Array<{ room: string; event: string; payload?: unknown }> = [];
  return {
    roomEmits,
    namespace: {
      to(room: string) {
        return {
          emit: (event: string, payload?: unknown) =>
            roomEmits.push({ room, event, payload }),
        };
      },
    },
  };
}

/** The announcer debounces at 500ms; tests wait past it for real, because the
 *  timers are real and short by design. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 650));

/** The health announcer settles at 750ms. */
const settleHealth = () => new Promise((resolve) => setTimeout(resolve, 900));

beforeEach(() => {
  vi.clearAllMocks();
  getRunState.mockReturnValue({ status: "idle" });
  resetHmrSockets();
});

describe("createPreviewAnnouncer", () => {
  it("tells the project's room when a live run's files change", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toEqual([{ room: PROJECT, event: "previewChanged" }]);
  });

  /** A burst of watcher events is one save, not one reload per event. */
  it("collapses a burst of changes into one announcement", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    announcer.announce(PROJECT);
    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toHaveLength(1);
  });

  /** With nothing listening, a reload re-fetches the "not running"
   *  placeholder — noise, not information. */
  it("says nothing while the run is not live", async () => {
    getRunState.mockReturnValue({ status: "starting" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    await settle();

    getRunState.mockReturnValue({ status: "exited" });
    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toHaveLength(0);
  });

  /** The run state is read at announce time, not captured once, so a save
   *  after the run stopped does not reload a dead preview. */
  it("re-checks the run state for each announcement", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    await settle();

    getRunState.mockReturnValue({ status: "idle" });
    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toHaveLength(1);
  });

  it("drops pending announcements on dispose", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    announcer.dispose();
    await settle();

    expect(roomEmits).toHaveLength(0);
  });
});

describe("createPreviewHealthAnnouncer", () => {
  it("tells the room when the dev server starts answering with errors", async () => {
    const { namespace, roomEmits } = makeNamespace();
    const health = createPreviewHealthAnnouncer(namespace as never);

    health.observe(PROJECT, false);
    await settleHealth();

    expect(roomEmits).toContainEqual({
      room: PROJECT,
      event: "previewError",
      payload: { status: 500 },
    });
  });

  it("announces recovery, and then goes quiet while the state holds", async () => {
    const { namespace, roomEmits } = makeNamespace();
    const health = createPreviewHealthAnnouncer(namespace as never);

    health.observe(PROJECT, false);
    await settleHealth();

    health.observe(PROJECT, true);
    await settleHealth();

    // Still healthy — a chatty dev server must not re-announce either state.
    health.observe(PROJECT, true);
    health.observe(PROJECT, true);
    await settleHealth();

    const events = roomEmits.map((emit) => emit.event);
    expect(events).toEqual(["previewError", "previewRecovered"]);
  });

  /** A page, its chunks and its HMR fetches fail together; the room hears
   *  about the bout once. */
  it("collapses a burst of failures into one announcement", async () => {
    const { namespace, roomEmits } = makeNamespace();
    const health = createPreviewHealthAnnouncer(namespace as never);

    for (let i = 0; i < 5; i++) health.observe(PROJECT, false);
    await settleHealth();

    expect(
      roomEmits.filter((emit) => emit.event === "previewError"),
    ).toHaveLength(1);
  });

  /** An error followed by a recovery inside the window is nothing at all:
   *  the room never heard about the error. */
  it("does not announce an error that recovered before the window closed", async () => {
    const { namespace, roomEmits } = makeNamespace();
    const health = createPreviewHealthAnnouncer(namespace as never);

    health.observe(PROJECT, false);
    health.observe(PROJECT, true);
    await settleHealth();

    expect(roomEmits).toHaveLength(0);
  });

  it("forgets pending announcements on dispose", async () => {
    const { namespace, roomEmits } = makeNamespace();
    const health = createPreviewHealthAnnouncer(namespace as never);

    health.observe(PROJECT, false);
    health.dispose();
    await settleHealth();

    expect(roomEmits).toHaveLength(0);
  });
});

describe("HMR sockets", () => {
  /** A live HMR socket means the dev server delivers the update itself; our
   *  reload would discard the state it just preserved. */
  it("the announcer stays quiet while a HMR socket is connected", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    noteHmrOpen(PROJECT);
    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toHaveLength(0);

    // The socket drops — the next save falls back to a full reload.
    noteHmrClosed(PROJECT);
    announcer.announce(PROJECT);
    await settle();

    expect(roomEmits).toEqual([{ room: PROJECT, event: "previewChanged" }]);
  });

  /** Checked when the debounce fires, so a socket that connects while the
   *  announcement is pending still wins. */
  it("a socket connected during the debounce window cancels the reload", async () => {
    getRunState.mockReturnValue({ status: "running" });
    const { namespace, roomEmits } = makeNamespace();
    const announcer = createPreviewAnnouncer(namespace as never);

    announcer.announce(PROJECT);
    noteHmrOpen(PROJECT);
    await settle();

    expect(roomEmits).toHaveLength(0);
  });

  it("two sockets: the first closing leaves the second live", () => {
    noteHmrOpen(PROJECT);
    noteHmrOpen(PROJECT);
    noteHmrClosed(PROJECT);
    expect(hasLiveHmr(PROJECT)).toBe(true);

    noteHmrClosed(PROJECT);
    expect(hasLiveHmr(PROJECT)).toBe(false);
  });

  /** A socket that errors often fires `error` and `close`; the extra close
   *  must not drive the count so far down that a later socket reads as dead.
   */
  it("a double close of one socket does not eat a later socket's count", () => {
    noteHmrOpen(PROJECT);
    noteHmrClosed(PROJECT);
    noteHmrClosed(PROJECT);
    expect(hasLiveHmr(PROJECT)).toBe(false);

    noteHmrOpen(PROJECT);
    expect(hasLiveHmr(PROJECT)).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
