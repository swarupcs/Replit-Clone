// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitPane } from "./SplitPane.tsx";

/** jsdom implements neither pointer capture nor layout. Both are stubbed to
 *  the minimum this component actually reads. */
const captured: number[] = [];

beforeEach(() => {
  captured.length = 0;
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    captured.push(id);
  };
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => captured.length > 0;

  // A 1000px-wide container, so a move to clientX 400 means a 400px pane.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 1000,
    right: 1000,
    bottom: 1000,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPane(onResizeEnd?: (size: number) => void) {
  render(
    <SplitPane
      defaultSize={300}
      first={<div data-testid="first">left</div>}
      second={<div data-testid="second">right</div>}
      onResizeEnd={onResizeEnd}
    />,
  );

  const divider = screen.getByRole("separator");
  // The first pane is the divider's previous sibling; its flex-basis is the
  // size under test.
  const firstPane = divider.previousElementSibling as HTMLElement;
  return { divider, firstPane, sizeOf: () => firstPane.style.flexBasis };
}

/** A pointermove on `window`, the way a real drag delivers them. */
function movePointer(clientX: number, buttons = 1) {
  fireEvent(
    window,
    new MouseEvent("pointermove", { clientX, buttons, bubbles: true }),
  );
}

describe("dragging the divider", () => {
  it("resizes the first pane while the pointer is down", () => {
    const { divider, sizeOf } = renderPane();

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);

    expect(sizeOf()).toBe("400px");
  });

  it("reports the final size once, on release", () => {
    const onResizeEnd = vi.fn();
    const { divider } = renderPane(onResizeEnd);

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);
    movePointer(450);
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenCalledWith(450);
  });

  it("stops following the pointer after release", () => {
    const { divider, sizeOf } = renderPane();

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    movePointer(600);

    expect(sizeOf()).toBe("400px");
  });
});

/** The reported bug: after letting go, the divider kept following the mouse.
 *
 *  The release happened over the preview iframe, and a cross-origin frame
 *  consumes the pointer stream rather than letting it reach this document — so
 *  the `pointerup` this component was waiting on never arrived.
 */
describe("a release this document never sees", () => {
  /** The actual fix. jsdom cannot host a real cross-origin iframe, so what is
   *  pinned here is that capture is requested at all: capture is what
   *  guarantees the release comes back to the divider whatever it is over. */
  it("captures the pointer so the release cannot be stolen", () => {
    const { divider } = renderPane();

    fireEvent.pointerDown(divider, { pointerId: 7 });

    expect(captured).toEqual([7]);
  });

  /** The safety net, which does not depend on capture working. */
  it("ends the drag on the first move with no button held", () => {
    const onResizeEnd = vi.fn();
    const { divider, sizeOf } = renderPane(onResizeEnd);

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);

    // The pointerup went to the iframe. The next move arrives with no button
    // down, which is the giveaway.
    movePointer(500, 0);
    expect(sizeOf()).toBe("400px");
    expect(onResizeEnd).toHaveBeenCalledWith(400);

    // And it is genuinely over, not merely skipped once.
    movePointer(600);
    expect(sizeOf()).toBe("400px");
  });

  it("ends the drag when the pointer is cancelled", () => {
    const { divider, sizeOf } = renderPane();

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);
    fireEvent(window, new MouseEvent("pointercancel", { bubbles: true }));
    movePointer(600);

    expect(sizeOf()).toBe("400px");
  });

  it("ends the drag if the capture is taken away", () => {
    const { divider, sizeOf } = renderPane();

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);
    fireEvent.lostPointerCapture(divider, { pointerId: 1 });
    movePointer(600);

    expect(sizeOf()).toBe("400px");
  });

  it("reports the size only once when several endings arrive together", () => {
    const onResizeEnd = vi.fn();
    const { divider } = renderPane(onResizeEnd);

    fireEvent.pointerDown(divider, { pointerId: 1 });
    movePointer(400);

    // A real release fires pointerup AND lostpointercapture.
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    fireEvent.lostPointerCapture(divider, { pointerId: 1 });

    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});
