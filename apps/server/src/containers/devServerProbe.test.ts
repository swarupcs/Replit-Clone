import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isServing } from "./devServerProbe.js";

/** Real sockets throughout. The whole point of this module is a distinction
 *  between two things that look identical to a connect(), so stubbing the
 *  network away would test nothing at all. */

let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

function track(server: net.Server): Promise<string> {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
}

/** A dev server. */
function serving(statusCode = 200): Promise<string> {
  return track(
    http.createServer((_request, response) => {
      response.writeHead(statusCode);
      response.end("hello");
    }),
  );
}

/** Docker's published-port proxy with nothing behind it: the connection is
 *  accepted, because the proxy binds the port for as long as the container
 *  lives, and then dropped when there is nothing to forward it to. This is
 *  exactly what a project whose dev server has not started yet — or has died —
 *  looks like from the host on Windows and macOS. */
function acceptsThenHangsUp(): Promise<string> {
  return track(
    net.createServer((socket) => {
      socket.destroy();
    }),
  );
}

/** A port that accepts and then says nothing at all, which is the same proxy
 *  when the container is up but wedged. */
function acceptsAndGoesQuiet(): Promise<string> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    return Promise.resolve();
  });
  return track(server);
}

describe("something is serving", () => {
  it("is true when a dev server answers", async () => {
    await expect(isServing(await serving())).resolves.toBe(true);
  });

  /** An app with no route at "/" is still an app, and the preview may well be
   *  pointed somewhere else. Requiring 200 would leave those projects reported
   *  as never ready. */
  it("is true for any status the dev server chooses", async () => {
    await expect(isServing(await serving(404))).resolves.toBe(true);
    await expect(isServing(await serving(500))).resolves.toBe(true);
  });
});

describe("nothing is serving", () => {
  /** The defect this module exists for. A connect() succeeds here, which is
   *  why the old check reported every project with a container as running —
   *  through its whole `npm install`, and for ever after its dev server died. */
  it("is false when the port is answered but nothing is behind it", async () => {
    await expect(isServing(await acceptsThenHangsUp())).resolves.toBe(false);
  });

  it("is false when the connection is accepted and then ignored", async () => {
    await expect(isServing(await acceptsAndGoesQuiet(), 300)).resolves.toBe(
      false,
    );
  });

  it("is false when nothing is listening at all", async () => {
    // Port 1 is not ours to bind and nothing serves on it.
    await expect(isServing("http://127.0.0.1:1")).resolves.toBe(false);
  });

  it("is false rather than throwing for a target that is not a URL", async () => {
    await expect(isServing("not a url")).resolves.toBe(false);
  });
});

describe("the timeout", () => {
  it("gives up rather than holding the caller open", async () => {
    const started = Date.now();

    await isServing(await acceptsAndGoesQuiet(), 200);

    // Generous, because CI is slow; what matters is that it returned at all.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
