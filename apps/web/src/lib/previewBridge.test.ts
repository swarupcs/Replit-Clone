import { describe, expect, it } from "vitest";
import { BRIDGE_CHANNEL, BRIDGE_LIMITS, injectBridge } from "@replit-clone/shared";
import { DEVICE_PRESETS, parseBridgeMessage, presetById } from "./previewBridge.ts";

/** §13.5's boundary. Everything here arrives from code the editor does not
 *  control — the user's app, or a stranger's in a sandbox — so these tests are
 *  mostly about what is REFUSED. */

const frame = { name: "the-iframe" } as unknown as Window;
const other = { name: "something-else" } as unknown as Window;

function message(record: unknown, source: Window | null = frame) {
  return { data: { channel: BRIDGE_CHANNEL, record }, source } as Pick<
    MessageEvent,
    "data" | "source"
  >;
}

describe("admitting a message from the preview", () => {
  it("accepts a console record from the right frame", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "console", level: "warn", text: "careful", at: 5 }),
      frame,
    );

    expect(parsed).toEqual({ kind: "console", level: "warn", text: "careful", at: 5 });
  });

  it("REFUSES a message from any other window", () => {
    // The check that still works for a sandboxed iframe, whose origin is the
    // string "null" and therefore identical to every other opaque frame's.
    const parsed = parseBridgeMessage(
      message({ kind: "console", level: "log", text: "hi", at: 1 }, other),
      frame,
    );

    expect(parsed).toBeNull();
  });

  it("refuses everything when there is no frame to compare against", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "console", level: "log", text: "hi", at: 1 }, null),
      null,
    );

    expect(parsed).toBeNull();
  });

  it("ignores traffic on another channel", () => {
    // Vite's HMR, a third-party widget, the editor's own announcements.
    const parsed = parseBridgeMessage(
      { data: { channel: "vite:hmr", record: { kind: "console" } }, source: frame } as Pick<
        MessageEvent,
        "data" | "source"
      >,
      frame,
    );

    expect(parsed).toBeNull();
  });

  it.each([null, undefined, "a string", 42, []])("ignores %s as a payload", (data) => {
    const parsed = parseBridgeMessage(
      { data, source: frame } as Pick<MessageEvent, "data" | "source">,
      frame,
    );
    expect(parsed).toBeNull();
  });

  it("refuses a console level it does not know", () => {
    // An unknown level would reach a switch in the panel and render as nothing.
    expect(parseBridgeMessage(message({ kind: "console", level: "catastrophe" }), frame))
      .toBeNull();
  });

  it("refuses a record with no kind it handles", () => {
    expect(parseBridgeMessage(message({ kind: "exfiltrate", text: "x" }), frame)).toBeNull();
  });

  it("clips text the preview sent past the cap", () => {
    // The bridge clips too. This is the same clip on arrival, because a preview
    // that ignores the limit is exactly the preview that would.
    const parsed = parseBridgeMessage(
      message({ kind: "console", level: "log", text: "x".repeat(50_000), at: 1 }),
      frame,
    );

    if (parsed?.kind !== "console") throw new Error("expected a console record");
    expect(parsed.text.length).toBe(BRIDGE_LIMITS.textBytes + 1);
  });

  it("substitutes its own clock when the preview does not send one", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "console", level: "log", text: "hi" }),
      frame,
    );

    if (parsed?.kind !== "console") throw new Error("expected a console record");
    expect(parsed.at).toBeGreaterThan(0);
  });
});

describe("an error record", () => {
  it("keeps the position and the stack when the browser gave them", () => {
    const parsed = parseBridgeMessage(
      message({
        kind: "error",
        message: "x is not a function",
        source: "http://preview/app.js",
        line: 12,
        column: 4,
        stack: "TypeError: x is not a function",
        at: 9,
      }),
      frame,
    );

    expect(parsed).toMatchObject({ kind: "error", line: 12, column: 4, rejection: false });
  });

  it("tells an unhandled rejection from a thrown error", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "error", message: "nope", rejection: true }),
      frame,
    );

    expect(parsed).toMatchObject({ rejection: true });
  });

  it("refuses an error with no message, which has no row to show", () => {
    expect(parseBridgeMessage(message({ kind: "error", message: "" }), frame)).toBeNull();
  });

  it("drops a line number that is not one rather than rendering NaN", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "error", message: "boom", line: "twelve" }),
      frame,
    );

    if (parsed?.kind !== "error") throw new Error("expected an error record");
    expect(parsed.line).toBeUndefined();
  });
});

describe("a network record", () => {
  it("keeps the method, url, status and duration", () => {
    const parsed = parseBridgeMessage(
      message({
        kind: "network",
        method: "post",
        url: "/api/things",
        status: 201,
        ms: 34,
        failed: false,
      }),
      frame,
    );

    expect(parsed).toMatchObject({ method: "POST", url: "/api/things", status: 201, ms: 34 });
  });

  it("bounds a method the preview invented", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "network", url: "/x", method: "M".repeat(500) }),
      frame,
    );

    if (parsed?.kind !== "network") throw new Error("expected a network record");
    expect(parsed.method.length).toBe(16);
  });

  it("refuses a request with no url", () => {
    expect(parseBridgeMessage(message({ kind: "network", method: "GET" }), frame)).toBeNull();
  });

  it("leaves status absent for a request that never got an answer", () => {
    const parsed = parseBridgeMessage(
      message({ kind: "network", url: "/x", failed: true }),
      frame,
    );

    if (parsed?.kind !== "network") throw new Error("expected a network record");
    expect(parsed.status).toBeUndefined();
    expect(parsed.failed).toBe(true);
  });
});

describe("injecting the bridge into a document", () => {
  it("goes inside head, before the app's own code runs", () => {
    // A bridge added after the module that throws has missed the error it
    // exists to report.
    const html = injectBridge("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(html.indexOf("__rcDevtools")).toBeLessThan(html.indexOf("<title>"));
  });

  it("goes before body when there is no head", () => {
    const html = injectBridge("<body><div id=root></div></body>");
    expect(html.indexOf("__rcDevtools")).toBeLessThan(html.indexOf("<body>"));
  });

  it("still injects into a bare fragment", () => {
    expect(injectBridge("<div id=root></div>")).toContain("__rcDevtools");
  });

  it("installs once even if a document somehow carries it twice", () => {
    // The guard is in the script itself; this asserts the guard exists, since
    // two copies wrapping console twice would double every message.
    expect(injectBridge("<head></head>")).toContain("if (window.__rcDevtools) return;");
  });

  it("calls the real console before reporting", () => {
    // Somebody who does have devtools open must lose nothing by this.
    expect(injectBridge("<head></head>")).toContain("original.apply(console, arguments)");
  });
});

describe("the device frame", () => {
  it("offers fit first, which is the editor's ordinary preview", () => {
    expect(DEVICE_PRESETS[0]).toMatchObject({ id: "fit", width: null });
  });

  it("falls back to fit for an id it does not know", () => {
    expect(presetById("nonsense").id).toBe("fit");
  });

  it("names sizes rather than devices, because this frames and does not emulate", () => {
    // Calling one "iPhone 15" would promise a pixel ratio and a user-agent
    // string that are not here.
    for (const preset of DEVICE_PRESETS.slice(1)) {
      expect(preset.label).toMatch(/\d+×\d+/);
    }
  });
});
