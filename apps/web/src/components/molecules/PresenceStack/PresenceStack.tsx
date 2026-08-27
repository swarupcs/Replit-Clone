import { Tooltip } from "antd";
import { usePresenceStore } from "../../../store/presenceStore.ts";
import type { Peer } from "../../../lib/collab.ts";

/** How many faces before the rest become "+n". */
const SHOWN = 3;

/** The initial to put in a circle. Email addresses are what identity is here,
 *  so the first character of the local part is the best available. */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

function Face({
  peer,
  following,
  onToggleFollow,
}: {
  peer: Peer;
  following: boolean;
  onToggleFollow: () => void;
}) {
  return (
    <Tooltip
      title={
        peer.files.length > 0
          ? `${peer.name} — in ${peer.files.join(", ")}`
          : peer.name
      }
    >
      <button
        type="button"
        aria-label={
          following
            ? `Stop following ${peer.name}`
            : `Follow ${peer.name} to the file they are in`
        }
        aria-pressed={following}
        onClick={onToggleFollow}
        style={{
          padding: 0,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          width: 17,
          height: 17,
          marginLeft: -5,
          borderRadius: 999,
          // A ring in the bar's own colour, so overlapping faces stay
          // separable rather than merging into one blob.
          border: "1.5px solid var(--rc-surface-raised)",
          background: peer.color,
          color: "var(--rc-bg)",
          fontSize: 9,
          fontWeight: 700,
          flex: "none",
          // Following is shown on the face itself rather than in a separate
          // indicator: the face is what was clicked, so it is where the
          // answer belongs.
          outline: following ? `2px solid ${peer.color}` : undefined,
          outlineOffset: 1,
        }}
      >
        {initial(peer.name)}
      </button>
    </Tooltip>
  );
}

/** Who else is in the project.
 *
 *  The awareness transport has been running all along — every collaborator's
 *  name and colour was already crossing the wire — and the only place a human
 *  ever saw one was the member list inside the Share dialog.
 *
 *  Presence exists per document, so this shows people who have a file open. A
 *  collaborator sitting in the project with nothing open is connected but not
 *  in any document, and cannot be seen from here.
 */
export const PresenceStack = () => {
  const peers = usePresenceStore((state) => state.peers);
  const following = usePresenceStore((state) => state.following);
  const follow = usePresenceStore((state) => state.follow);

  if (peers.length === 0) return null;

  const shown = peers.slice(0, SHOWN);
  const rest = peers.length - shown.length;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", paddingLeft: 5 }}
      title={`${String(peers.length)} other${peers.length === 1 ? "" : "s"} here`}
    >
      {shown.map((peer) => (
        <Face
          key={peer.key}
          peer={peer}
          following={following === peer.key}
          onToggleFollow={() => follow(following === peer.key ? null : peer.key)}
        />
      ))}

      {rest > 0 && (
        <Tooltip title={peers.slice(SHOWN).map((peer) => peer.name).join(", ")}>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              height: 17,
              minWidth: 17,
              padding: "0 4px",
              marginLeft: -5,
              borderRadius: 999,
              border: "1.5px solid var(--rc-surface-raised)",
              background: "var(--rc-selection)",
              color: "var(--rc-text)",
              fontSize: 9,
              fontWeight: 700,
              flex: "none",
            }}
          >
            +{rest}
          </span>
        </Tooltip>
      )}
    </span>
  );
};
