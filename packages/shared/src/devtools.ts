/** Devtools for the thing being previewed. plan.md §13.5.
 *
 *  The preview is an iframe pointed at somebody's app, and that is all it is. A
 *  runtime `TypeError` in there lands in the *real* browser's console — which
 *  the reader of a shared link does not have open, would not know to open, and
 *  on a tablet does not have. So the preview reports its own console, its own
 *  failures and its own requests over `postMessage`, and the editor shows them.
 *
 *  **Everything crossing this boundary is untrusted.** The previewed code is the
 *  user's, or a stranger's in a sandbox (§13.1), and it can post anything it
 *  likes — including messages shaped like these. The parent validates every
 *  field and checks the sender; see `previewBridge.ts` on the web side, whose
 *  whole job is to not believe this.
 */

/** The namespace on every message, so unrelated `postMessage` traffic — Vite's
 *  HMR, a third-party widget, the editor's own announcements — is ignored
 *  rather than parsed. */
export const BRIDGE_CHANNEL = "replit-clone-preview-devtools";

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleRecord {
  kind: "console";
  level: ConsoleLevel;
  /** Already stringified in the preview: structured clone cannot carry a DOM
   *  node, a function or a circular object, and a bridge that throws while
   *  reporting an error is worse than no bridge. */
  text: string;
  at: number;
}

export interface ErrorRecord {
  kind: "error";
  message: string;
  /** Where, when the browser says. A cross-origin script reports nothing. */
  source: string | undefined;
  line: number | undefined;
  column: number | undefined;
  stack: string | undefined;
  /** An unhandled rejection rather than a thrown error — different thing,
   *  different advice, so the panel can say which. */
  rejection: boolean;
  at: number;
}

export interface NetworkRecord {
  kind: "network";
  method: string;
  url: string;
  /** Absent when the request never got an answer. */
  status: number | undefined;
  ms: number;
  failed: boolean;
  at: number;
}

export type BridgeRecord = ConsoleRecord | ErrorRecord | NetworkRecord;

export interface BridgeMessage {
  channel: typeof BRIDGE_CHANNEL;
  record: BridgeRecord;
}

/** How much the preview may say before it is cut off.
 *
 *  A loop logging inside `requestAnimationFrame` produces sixty messages a
 *  second forever. These caps are what stops the panel from being a memory
 *  leak with a scrollbar — applied in the preview so the messages are never
 *  sent, and again in the store so a preview that ignores them gains nothing.
 */
export const BRIDGE_LIMITS = {
  /** One message's text. Long enough for a stack, short enough that a thousand
   *  of them is megabytes rather than hundreds. */
  textBytes: 8_000,
  /** Messages per second, after which the preview stops sending and says so
   *  once. */
  perSecond: 100,
} as const;

/** The script that runs inside the preview.
 *
 *  A string rather than a module because it is injected into somebody else's
 *  document and has to survive with no bundler, no imports and no assumptions
 *  about what else is on the page. It is wrapped in an IIFE and touches
 *  nothing it does not own except the four things it is here to observe.
 *
 *  **It never replaces the real console.** The original methods are called
 *  first and the report is a side effect, so the actual browser console behaves
 *  exactly as it did — somebody who *does* have devtools open loses nothing.
 */
export const BRIDGE_SOURCE = `(function () {
  if (window.__rcDevtools) return;
  window.__rcDevtools = true;

  var CHANNEL = ${JSON.stringify(BRIDGE_CHANNEL)};
  var MAX_TEXT = ${String(BRIDGE_LIMITS.textBytes)};
  var PER_SECOND = ${String(BRIDGE_LIMITS.perSecond)};

  var windowStart = Date.now();
  var sentThisSecond = 0;
  var muted = false;

  function send(record) {
    var now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      sentThisSecond = 0;
      muted = false;
    }
    if (muted) return;
    if (++sentThisSecond > PER_SECOND) {
      muted = true;
      record = {
        kind: "console",
        level: "warn",
        text: "Preview devtools: too many messages, muted for the rest of this second.",
        at: now,
      };
    }
    try {
      parent.postMessage({ channel: CHANNEL, record: record }, "*");
    } catch (error) {
      // A record that cannot be cloned must not take the page down with it.
    }
  }

  function clip(text) {
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\\u2026" : text;
  }

  /** Stringify here rather than sending the value: structured clone cannot
   *  carry a DOM node, a function or a circular object, and console.log of any
   *  of those is completely ordinary. */
  function describe(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof Node !== "undefined" && value instanceof Node) {
      return "[" + value.nodeName + "]";
    }
    try {
      return JSON.stringify(value, seen()) ?? String(value);
    } catch (error) {
      return String(value);
    }
  }

  function seen() {
    var visited = new WeakSet();
    return function (key, value) {
      if (typeof value !== "object" || value === null) return value;
      if (visited.has(value)) return "[Circular]";
      visited.add(value);
      return value;
    };
  }

  var LEVELS = ["log", "info", "warn", "error", "debug"];
  LEVELS.forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      // The real console FIRST and unconditionally: somebody with devtools
      // actually open must lose nothing by this being here.
      try {
        original.apply(console, arguments);
      } catch (error) {}
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
      send({ kind: "console", level: level, text: clip(parts.join(" ")), at: Date.now() });
    };
  });

  window.addEventListener("error", function (event) {
    send({
      kind: "error",
      message: clip(String(event.message || "Script error")),
      source: event.filename || undefined,
      line: typeof event.lineno === "number" ? event.lineno : undefined,
      column: typeof event.colno === "number" ? event.colno : undefined,
      stack: event.error && event.error.stack ? clip(String(event.error.stack)) : undefined,
      rejection: false,
      at: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send({
      kind: "error",
      message: clip(reason instanceof Error ? reason.message : describe(reason)),
      source: undefined,
      line: undefined,
      column: undefined,
      stack: reason instanceof Error && reason.stack ? clip(String(reason.stack)) : undefined,
      rejection: true,
      at: Date.now(),
    });
  });

  var originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      var started = Date.now();
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      return originalFetch.apply(window, arguments).then(
        function (response) {
          send({
            kind: "network",
            method: String(method).toUpperCase(),
            url: clip(String(url)),
            status: response.status,
            ms: Date.now() - started,
            failed: !response.ok,
            at: started,
          });
          return response;
        },
        function (error) {
          send({
            kind: "network",
            method: String(method).toUpperCase(),
            url: clip(String(url)),
            status: undefined,
            ms: Date.now() - started,
            failed: true,
            at: started,
          });
          throw error;
        },
      );
    };
  }

  var XHR = window.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype && XHR.prototype.open) {
    var open = XHR.prototype.open;
    var sendMethod = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__rcMethod = String(method || "GET").toUpperCase();
      this.__rcUrl = String(url || "");
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var request = this;
      var started = Date.now();
      request.addEventListener("loadend", function () {
        send({
          kind: "network",
          method: request.__rcMethod || "GET",
          url: clip(request.__rcUrl || ""),
          // status 0 is how a blocked or aborted XHR reports, which is not a
          // status anybody wants displayed as one.
          status: request.status === 0 ? undefined : request.status,
          ms: Date.now() - started,
          failed: request.status === 0 || request.status >= 400,
          at: started,
        });
      });
      return sendMethod.apply(this, arguments);
    };
  }
})();`;

/** Puts the bridge into a document, before anything else runs.
 *
 *  **In `<head>`, and as early in it as possible.** The point is to be
 *  installed before the app's own code executes: a bridge added after the
 *  module that throws has already missed the error it exists to report.
 */
export function injectBridge(html: string): string {
  const tag = `<script>${BRIDGE_SOURCE}</script>`;

  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }

  // No `<head>` is entirely legal — a fragment, or a document the author wrote
  // without one. Before `<body>` is the next-earliest point; failing that, the
  // front, which a browser will treat as implicitly inside head anyway.
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index) + tag + html.slice(body.index);

  return tag + html;
}
