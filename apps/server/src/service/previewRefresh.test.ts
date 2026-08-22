import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRunState = vi.hoisted(() => vi.fn(() => ({ status: "idle" })));

vi.mock("../containers/runner.js", () => ({ getRunState }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createPreviewAnnouncer } from "./previewRefresh.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A stand-in namespace that records room broadcasts. */
function makeNamespace() {
  const roomEmits: Array<{ room: string; event: string }> = [];
  return {
    roomEmits,
    namespace: {
      to(room: string) {
        return { emit: (event: string) => roomEmits.push({ room, event }) };
      },
    },
  };
}

/** The announcer debounces at 500ms; tests wait past it for real, because the
 *  timers are real and short by design. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 650));

beforeEach(() => {
  vi.clearAllMocks();
  getRunState.mockReturnValue({ status: "idle" });
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

afterEach(() => {
  vi.useRealTimers();
});
