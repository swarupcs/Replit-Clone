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
}: SplitPaneProps) => {
  const isHorizontal = direction === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(defaultSize);
  const [dragging, setDragging] = useState(false);

  const handleMove = useCallback(
    (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const raw = isHorizontal
        ? event.clientX - rect.left
        : event.clientY - rect.top;

      const limit = (isHorizontal ? rect.width : rect.height) - DIVIDER - minSize;
      setSize(Math.max(minSize, Math.min(raw, Math.min(maxSize, limit))));
    },
    [isHorizontal, minSize, maxSize],
  );

  useEffect(() => {
    if (!dragging) return;

    const stop = () => setDragging(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);

    // Without this, dragging over the editor or the preview iframe selects text
    // and the pointer stream stutters.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = "";
    };
  }, [dragging, handleMove, isHorizontal]);

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
            setDragging(true);
          }}
          className="rc-divider"
          data-dragging={dragging}
          style={{
            flex: `0 0 ${DIVIDER}px`,
            cursor: isHorizontal ? "col-resize" : "row-resize",
          }}
        />
      )}

      {showSecond && (
        <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
          {second}
        </div>
      )}
    </div>
  );
};
