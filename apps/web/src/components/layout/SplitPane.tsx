import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface SplitPaneProps {
  /** "horizontal" splits left|right; "vertical" splits top/bottom. */
  direction?: "horizontal" | "vertical";
  /** Initial size of the FIRST pane, in pixels. */
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  /** When false, only the second pane renders and the divider is hidden. */
  showFirst?: boolean;
  showSecond?: boolean;
  first: ReactNode;
  second: ReactNode;
  /** Classes for the pane wrappers.
   *
   *  The wrappers carry inline flex sizes, so a stylesheet can only reach them
   *  through a class it is given — which is how the narrow layout lifts a pane
   *  out of the split and into a drawer without any of this component knowing
   *  about breakpoints. */
  firstClassName?: string;
  secondClassName?: string;
  /** Called when the user finishes a drag, so the size can be remembered.
   *  Fired on release rather than per pointer move: persisting during a drag
   *  would write to storage dozens of times a second. */
  onResizeEnd?: (size: number) => void;
}

const DIVIDER = 5;

/** A two-pane resizable split.
 *
 *  Replaces `allotment`, which never initialised under React 19 — it applied no
 *  pane sizes and rendered no drag handles, collapsing the editor to zero width.
 *  This is a plain flex layout plus a pointer-driven divider, so there is no
 *  imperative measurement step to fail.
 */
export const SplitPane = ({
  direction = "horizontal",
  defaultSize,
  minSize = 80,
  maxSize = Infinity,
  showFirst = true,
  showSecond = true,
  first,
  second,
  firstClassName,
  secondClassName,
  onResizeEnd,
}: SplitPaneProps) => {
  const isHorizontal = direction === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(defaultSize);
  const [dragging, setDragging] = useState(false);

  /** The live size, readable from the pointerup handler without making it a
   *  dependency of the effect that registers it. */
  const sizeRef = useRef(size);
  sizeRef.current = size;

  /** Ends the drag and reports the final size. Idempotent: pointer capture,
   *  `pointerup` and the lost-button check below can each reach it. */
  const stopDragging = useCallback(() => {
    setDragging((wasDragging) => {
      if (wasDragging) onResizeEnd?.(sizeRef.current);
      return false;
    });
  }, [onResizeEnd]);

  const handleMove = useCallback(
    (event: PointerEvent) => {
      // No button held means the release was missed — most often because the
      // pointer was over the preview iframe when it happened, and a
      // cross-origin frame consumes the event rather than letting it reach
      // this document. Without this the divider kept following the mouse long
      // after the user let go.
      //
      // Belt to the braces of `setPointerCapture` below, which is what stops
      // the release going astray in the first place.
      if (event.buttons === 0) {
        stopDragging();
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const raw = isHorizontal
        ? event.clientX - rect.left
        : event.clientY - rect.top;

      const limit = (isHorizontal ? rect.width : rect.height) - DIVIDER - minSize;
      setSize(Math.max(minSize, Math.min(raw, Math.min(maxSize, limit))));
    },
    [isHorizontal, minSize, maxSize, stopDragging],
  );

  useEffect(() => {
    if (!dragging) return;

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stopDragging);
    // A cancelled pointer (the OS taking over, a touch becoming a gesture)
    // never produces a pointerup, and would otherwise leave the drag stuck in
    // exactly the same way.
    window.addEventListener("pointercancel", stopDragging);

    // Without this, dragging over the editor or the preview iframe selects text
    // and the pointer stream stutters.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = "";
    };
  }, [dragging, handleMove, isHorizontal, stopDragging]);

  const bothVisible = showFirst && showSecond;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {showFirst && (
        <div
          className={firstClassName}
          style={{
            // When it is the only pane it takes everything; otherwise it is
            // fixed at `size` and the second pane absorbs the remainder.
            flex: bothVisible ? `0 0 ${size}px` : "1 1 auto",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {first}
        </div>
      )}

      {bothVisible && (
        <div
          role="separator"
          aria-orientation={isHorizontal ? "vertical" : "horizontal"}
          onPointerDown={(event) => {
            event.preventDefault();

            // The fix for a drag that never ended. Everything below the
            // divider is fair game to drag across, and one of those things is
            // the preview iframe — which, being a separate (cross-origin)
            // document, consumes the pointer stream entirely. The release
            // happened inside it, this document never heard about it, and the
            // divider went on following the mouse.
            //
            // Capturing retargets every later event for this pointer to the
            // divider whatever sits underneath, so the release always comes
            // back here. It also covers letting go outside the window.
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          // Capture is released automatically when the pointer goes up, but
          // the drag state has to be dropped with it — if anything else takes
          // the capture away mid-drag, this is the only notice we get.
          onLostPointerCapture={stopDragging}
          className="rc-divider"
          data-dragging={dragging}
          style={{
            flex: `0 0 ${DIVIDER}px`,
            cursor: isHorizontal ? "col-resize" : "row-resize",
          }}
        />
      )}

      {showSecond && (
        <div
          className={secondClassName}
          style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, overflow: "hidden" }}
        >
          {second}
        </div>
      )}
    </div>
  );
};
