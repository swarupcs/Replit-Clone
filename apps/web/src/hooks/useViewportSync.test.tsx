// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const published: { relPath: string; top: number; bottom: number }[] = [];
const viewports = new Map<string, { top: number; bottom: number }>();
let announce: (() => void) | null = null;

vi.mock("../lib/collab.ts", () => ({
  publishViewport: (
    relPath: string,
    viewport: { top: number; bottom: number },
  ) => {
    published.push({ relPath, ...viewport });
  },
  viewportIn: (relPath: string, name: string) =>
    viewports.get(`${relPath}|${name}`),
  subscribeCollab: (listener: () => void) => {
    announce = listener;
    return () => {
      announce = null;
    };
  },
}));

import { useViewportSync } from "./useViewportSync.ts";
import { usePresenceStore } from "../store/presenceStore.ts";

const PATH = "src/App.jsx";
const THEM = "ada@example.com";

/** A Monaco editor as this hook uses it: a visible range, a scroll listener,
 *  and a way to be scrolled. `getTopForLineNumber` returns pixels, and the
 *  arithmetic here is deliberately trivial so a test can name the answer. */
function fakeEditor(firstLine = 1, lastLine = 30) {
  const scrolls: number[] = [];
  let listener: (() => void) | null = null;
  let first = firstLine;

  return {
    scrolls,
    /** Moves the editor and fires the scroll event, as scrolling does. */
    scrollTo(line: number) {
      first = line;
      listener?.();
    },
    /** Fires the scroll event without the visible lines having changed —
     *  a sub-line scroll, which is most of them. */
    jiggle() {
      listener?.();
    },
    editor: {
      getVisibleRanges: () => [
        { startLineNumber: first, endLineNumber: lastLine },
      ],
      onDidScrollChange: (handler: () => void) => {
        listener = handler;
        return {
          dispose: () => {
            listener = null;
          },
        };
      },
      getTopForLineNumber: (line: number) => line * 10,
      setScrollTop: (top: number) => {
        scrolls.push(top);
      },
    },
  };
}

function Harness(props: {
  editor: ReturnType<typeof fakeEditor>["editor"] | null;
  relPath?: string;
  enabled?: boolean;
}) {
  useViewportSync({
    editor: props.editor as never,
    relPath: props.relPath ?? PATH,
    enabled: props.enabled ?? true,
    mountTick: 1,
  });
  return null;
}

beforeEach(() => {
  published.length = 0;
  viewports.clear();
  announce = null;
  usePresenceStore.setState({ following: null });
});

afterEach(() => {
  cleanup();
});

describe("telling other people where we are", () => {
  it("publishes the visible lines as soon as it attaches", () => {
    const fake = fakeEditor(40, 70);
    render(<Harness editor={fake.editor} />);

    expect(published).toEqual([{ relPath: PATH, top: 40, bottom: 70 }]);
  });

  it("publishes again when the editor is scrolled", () => {
    const fake = fakeEditor(1, 30);
    render(<Harness editor={fake.editor} />);

    act(() => {
      fake.scrollTo(55);
    });

    expect(published.at(-1)).toEqual({ relPath: PATH, top: 55, bottom: 30 });
  });

  /** A viewer's pane holds no document, and a viewport belongs to a document.
   *  Publishing from one would be announcing a position in a file this client
   *  is not sharing. */
  it("says nothing while the pane is not collaborative", () => {
    const fake = fakeEditor();
    render(<Harness editor={fake.editor} enabled={false} />);

    act(() => {
      fake.scrollTo(20);
    });

    expect(published).toEqual([]);
  });

  it("stops listening when the pane goes away", () => {
    const fake = fakeEditor();
    const view = render(<Harness editor={fake.editor} />);
    view.unmount();

    const before = published.length;
    act(() => {
      fake.scrollTo(90);
    });

    expect(published).toHaveLength(before);
  });
});

describe("riding along with somebody", () => {
  it("does nothing at all while following nobody", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });

    render(<Harness editor={fake.editor} />);

    expect(fake.scrolls).toEqual([]);
  });

  it("scrolls to where they are once following starts", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });

    render(<Harness editor={fake.editor} />);
    act(() => {
      usePresenceStore.setState({ following: THEM });
    });

    // getTopForLineNumber is line * 10 in the fake.
    expect(fake.scrolls).toEqual([2000]);
  });

  it("follows them as their viewport moves", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    render(<Harness editor={fake.editor} />);

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    act(() => {
      viewports.set(`${PATH}|${THEM}`, { top: 300, bottom: 330 });
      announce?.();
    });

    expect(fake.scrolls).toEqual([2000, 3000]);
  });

  /** Scrolling to where the editor already is is not a no-op in Monaco: it
   *  cancels an in-flight smooth scroll. Awareness fires on every keystroke of
   *  the person being followed, so this would happen constantly. */
  it("does not scroll when already on their line", () => {
    const fake = fakeEditor(200, 230);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });

    render(<Harness editor={fake.editor} />);
    act(() => {
      usePresenceStore.setState({ following: THEM });
    });

    expect(fake.scrolls).toEqual([]);
  });

  it("stays put when they have published no viewport", () => {
    const fake = fakeEditor(1, 30);

    render(<Harness editor={fake.editor} />);
    act(() => {
      usePresenceStore.setState({ following: THEM });
    });

    expect(fake.scrolls).toEqual([]);
  });

  /** The loop this closes.
   *
   *  A followed scroll fires our own scroll handler, which would publish the
   *  new position as though we had chosen it. Harmless in one direction. Two
   *  people following each other would push one another back and forth
   *  forever, and neither could stop it by scrolling away.
   */
  it("does not republish a position it was moved to", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    render(<Harness editor={fake.editor} />);

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    expect(fake.scrolls).toEqual([2000]);

    // Monaco emits the scroll event as a consequence of setScrollTop, in its
    // own time. The fake makes both the consequence and the delay explicit —
    // and the delay is the point, because the first version of this guard was
    // a flag cleared on a timer, which is a race with exactly this event.
    const before = published.length;
    act(() => {
      fake.scrollTo(200);
    });

    expect(published).toHaveLength(before);
  });

  /** ...but only for that scroll. Once the follower scrolls away themselves,
   *  they are somewhere of their own choosing and anyone following THEM needs
   *  to know about it. A flag left set would make this client permanently
   *  silent. */
  it("publishes again once we scroll ourselves", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    render(<Harness editor={fake.editor} />);

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    act(() => {
      fake.scrollTo(200);
    });

    const before = published.length;
    act(() => {
      fake.scrollTo(500);
    });

    expect(published.at(-1)).toEqual({ relPath: PATH, top: 500, bottom: 30 });
    expect(published.length).toBeGreaterThan(before);
  });

  /** The reason the guard consumes rather than latches. Somebody who rides to
   *  line 200, scrolls away, and scrolls back to 200 has chosen that line the
   *  second time, and anyone following them needs to hear about it. */
  it("publishes a deliberate scroll back to the line it rode to", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    render(<Harness editor={fake.editor} />);

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    act(() => {
      fake.scrollTo(200);
    });
    act(() => {
      fake.scrollTo(5);
    });

    const before = published.length;
    act(() => {
      fake.scrollTo(200);
    });

    expect(published.at(-1)).toEqual({ relPath: PATH, top: 200, bottom: 30 });
    expect(published.length).toBeGreaterThan(before);
  });

  /** `setScrollTop` is a request, not a promise. Near the end of a file Monaco
   *  cannot put the asked-for line at the top and lands somewhere short of it,
   *  so the scroll that arrives is not the one that was expected. The line
   *  being waited for has to be given up at that point — left set, it would
   *  swallow the next deliberate scroll that happened to reach it. */
  it("gives up the expected line when the scroll lands elsewhere", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    render(<Harness editor={fake.editor} />);

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    // Asked for 200; the file ends and it lands on 120.
    act(() => {
      fake.scrollTo(120);
    });

    const before = published.length;
    act(() => {
      fake.scrollTo(200);
    });

    expect(published.at(-1)).toEqual({ relPath: PATH, top: 200, bottom: 30 });
    expect(published.length).toBeGreaterThan(before);
  });

  /** Following nobody is the common case — most panes, most of the time. The
   *  inward half should not be holding a subscription for all of them. */
  it("does not subscribe to presence while following nobody", () => {
    const fake = fakeEditor(1, 30);
    render(<Harness editor={fake.editor} />);

    expect(announce).toBeNull();

    act(() => {
      usePresenceStore.setState({ following: THEM });
    });
    expect(announce).not.toBeNull();
  });

  it("does not ride along in a pane that is not collaborative", () => {
    const fake = fakeEditor(1, 30);
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });

    render(<Harness editor={fake.editor} enabled={false} />);
    act(() => {
      usePresenceStore.setState({ following: THEM });
    });

    expect(fake.scrolls).toEqual([]);
  });

  it("does nothing before Monaco has produced an editor", () => {
    viewports.set(`${PATH}|${THEM}`, { top: 200, bottom: 230 });
    usePresenceStore.setState({ following: THEM });

    expect(() => {
      render(<Harness editor={null} />);
    }).not.toThrow();
    expect(published).toEqual([]);
  });
});
