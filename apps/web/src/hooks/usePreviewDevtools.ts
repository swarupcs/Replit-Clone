import { useEffect, type RefObject } from "react";
import { parseBridgeMessage } from "../lib/previewBridge.ts";
import { useDevtoolsStore } from "../store/devtoolsStore.ts";

/** Listens to one preview iframe. plan.md §13.5.
 *
 *  The listener is on `window` because that is where a frame's `postMessage`
 *  to its parent lands; what makes it *this* frame's listener is the identity
 *  check inside `parseBridgeMessage`, which compares the sender against this
 *  iframe's `contentWindow`. Origin is not usable for that — a sandboxed frame
 *  reports origin `"null"`, the same as every other opaque frame on the page.
 */
export function usePreviewDevtools(frame: RefObject<HTMLIFrameElement | null>): void {
  const record = useDevtoolsStore((state) => state.record);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Read the ref at delivery time, not when the effect ran: the iframe may
      // not have been mounted yet, and it is replaced on some reloads.
      const parsed = parseBridgeMessage(event, frame.current?.contentWindow ?? null);
      if (parsed) record(parsed);
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [frame, record]);
}
