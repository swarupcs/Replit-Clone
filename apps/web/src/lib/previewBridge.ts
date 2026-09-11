import {
  BRIDGE_CHANNEL,
  BRIDGE_LIMITS,
  type BridgeRecord,
  type ConsoleLevel,
} from "@replit-clone/shared";

/** Believing nothing the preview says. plan.md §13.5.
 *
 *  The previewed code is the user's own, or — in a sandbox (§13.1) — a
 *  stranger's, and it runs with `allow-scripts`. It can call `postMessage` with
 *  anything, including something shaped exactly like a bridge record. So this
 *  file's entire job is to decide what is admissible, and it is deliberately
 *  the least clever file in the feature.
 *
 *  **Two checks matter more than the field validation.** The sender must be the
 *  iframe this panel belongs to, and the channel must match. Origin is NOT one
 *  of them and cannot be: a sandboxed iframe without `allow-same-origin` has an
 *  opaque origin, so `event.origin` is the string `"null"` for exactly the
 *  previews that most need checking. `event.source` identity is the check that
 *  still means something there.
 */

const LEVELS = new Set<ConsoleLevel>(["log", "info", "warn", "error", "debug"]);

/** Trims anything the preview may have sent past the cap it was asked to obey.
 *
 *  The bridge clips too. This is the same clip applied again on arrival,
 *  because a preview that ignores the limit is exactly the preview that would.
 */
function clip(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.length > BRIDGE_LIMITS.textBytes
    ? `${text.slice(0, BRIDGE_LIMITS.textBytes)}…`
    : text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? clip(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A timestamp the preview claims. Taken as a hint and never as an ordering
 *  key: a page can set its clock wherever it likes, and a panel sorted by a
 *  hostile `at` is a panel that can be scrambled from inside the iframe. */
function stamp(value: unknown): number {
  return optionalNumber(value) ?? Date.now();
}

/** The record, or nothing at all.
 *
 *  `source` is the window the message must have come from — the iframe's
 *  `contentWindow`. Pass it and it is enforced; a caller with no iframe yet
 *  passes null and gets nothing admitted, which is the safe direction.
 */
export function parseBridgeMessage(
  event: Pick<MessageEvent, "data" | "source">,
  expected: Window | null,
): BridgeRecord | null {
  // Identity, not origin. A sandboxed iframe reports origin "null", so origin
  // would admit every other opaque-origin frame on the page.
  if (!expected || event.source !== expected) return null;

  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return null;

  const envelope = data as { channel?: unknown; record?: unknown };
  if (envelope.channel !== BRIDGE_CHANNEL) return null;

  const raw = envelope.record;
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;

  if (record["kind"] === "console") {
    const level = record["level"];
    // An unknown level would reach a switch in the panel and render as
    // nothing, so it is normalised here rather than guessed at there.
    if (typeof level !== "string" || !LEVELS.has(level as ConsoleLevel)) return null;

    return {
      kind: "console",
      level: level as ConsoleLevel,
      text: clip(record["text"]),
      at: stamp(record["at"]),
    };
  }

  if (record["kind"] === "error") {
    const message = clip(record["message"]);
    // An error with no message is not something to show a row for.
    if (message.length === 0) return null;

    return {
      kind: "error",
      message,
      source: optionalText(record["source"]),
      line: optionalNumber(record["line"]),
      column: optionalNumber(record["column"]),
      stack: optionalText(record["stack"]),
      rejection: record["rejection"] === true,
      at: stamp(record["at"]),
    };
  }

  if (record["kind"] === "network") {
    const url = clip(record["url"]);
    if (url.length === 0) return null;

    const method = typeof record["method"] === "string" ? record["method"] : "GET";

    return {
      kind: "network",
      // Bounded and upper-cased: a method is a token, and this one is going
      // into a table cell.
      method: method.slice(0, 16).toUpperCase(),
      url,
      status: optionalNumber(record["status"]),
      ms: optionalNumber(record["ms"]) ?? 0,
      failed: record["failed"] === true,
      at: stamp(record["at"]),
    };
  }

  return null;
}

export interface DevicePreset {
  id: string;
  label: string;
  /** Null means "fill the pane", which is the editor's ordinary preview. */
  width: number | null;
  height: number | null;
}

/** The device-size frame, which is the fourth thing §13.5 asks for.
 *
 *  Sizes rather than device names with pixel ratios and user-agent strings:
 *  this frames the iframe, it does not emulate a phone. Calling it "iPhone 15"
 *  would promise emulation that is not here.
 */
export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "fit", label: "Fit", width: null, height: null },
  { id: "phone", label: "Phone — 390×844", width: 390, height: 844 },
  { id: "tablet", label: "Tablet — 820×1180", width: 820, height: 1180 },
  { id: "desktop", label: "Desktop — 1280×800", width: 1280, height: 800 },
];

export function presetById(id: string): DevicePreset {
  return DEVICE_PRESETS.find((preset) => preset.id === id) ?? DEVICE_PRESETS[0]!;
}
