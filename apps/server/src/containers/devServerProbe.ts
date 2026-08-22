import http from "node:http";

/** Deciding whether a project's dev server is actually serving.
 *
 *  This used to open a TCP connection and take a successful connect as proof.
 *  On Linux, where the proxy dials the container's own address, that is sound.
 *  In `host-loopback` mode — the server running directly on Windows or macOS,
 *  where Docker Desktop gives the host no route to container IPs — it is not:
 *  Docker publishes the port by running a proxy on the host that binds it for
 *  as long as the CONTAINER lives. The connect is answered by that proxy, and
 *  it is answered whether or not anything inside the container is listening.
 *
 *  So the check said yes from the moment the container started. `npm install`
 *  had not finished, nothing was bound, and the run was already being promoted
 *  to "running" and the preview told to load. The badge said Running over a
 *  dead preview, and the reconciler would adopt a dev server that did not
 *  exist — which is the same lie, made permanent.
 *
 *  A request, rather than a connection, is what separates them: the proxy
 *  accepts and then hangs up when it cannot forward, while a dev server
 *  answers. Any status counts — a 404 from an app with no route at "/" is
 *  still an app.
 */

/** Long enough for a dev server busy compiling its first page, short enough
 *  that the poll behind this stays a poll. */
const PROBE_TIMEOUT_MS = 2500;

/** Whether something at `origin` answers an HTTP request. */
export async function isServing(
  origin: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(answered);
    };

    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        // GET rather than HEAD: a few dev servers and static handlers answer
        // HEAD oddly or not at all, and the body is discarded either way.
        method: "GET",
        path: "/",
        // Nothing here is reused, and leaving sockets open would hold the
        // agent's pool across every poll.
        headers: { connection: "close" },
        timeout: timeoutMs,
      },
      (response) => {
        // Whatever it said, something said it. The body is not wanted.
        response.destroy();
        done(true);
      },
    );

    request.on("timeout", () => {
      request.destroy();
      done(false);
    });

    // Refused, reset, or hung up by Docker's port proxy with nothing behind it.
    request.on("error", () => {
      done(false);
    });

    request.end();
  });
}
