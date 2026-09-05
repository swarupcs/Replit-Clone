import { Alert } from "antd";
import {
  selectConnectionNotice,
  useConnectionStore,
} from "../../../store/connectionStore.ts";

/** Says when this editor cannot reach its server. plan.md §11.7.
 *
 *  A cloud editor gets used on trains and on hotel wifi, and until this
 *  existed a dropped connection looked exactly like a working one: the cursor
 *  moved, the text changed, the tab said unsaved — which it also says a
 *  hundred times a minute while everything is fine — and nothing anywhere said
 *  the edits were not reaching the server.
 *
 *  Rendered above the editor rather than in the status bar, because it is the
 *  one message here that must not be missable. It is silent whenever there is
 *  nothing to say; see `selectConnectionNotice`, which stays quiet through the
 *  connecting state that every page load passes through.
 */
export function ConnectionNotice() {
  const notice = useConnectionStore(selectConnectionNotice);
  if (!notice) return null;

  return (
    <Alert
      type={notice.tone}
      showIcon
      banner
      role="status"
      message={notice.text}
      style={{ borderRadius: 0 }}
    />
  );
}
