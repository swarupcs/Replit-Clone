import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The real gateway process, driven over a real socket.
 *
 *  The unit tests beside this one cover the decision; this covers that the
 *  decision is actually consulted, on both the paths a client can take, and
 *  that a refusal reaches the caller as something they can read rather than a
 *  hung connection. Those are separate failures — a policy nothing calls is
 *  the more likely of the two, and no amount of testing the policy finds it.
 *
 *  `network.js` is the compiled address rule, copied beside the proxy by
 *  `pnpm images:prepare`. Absent on a fresh clone that has not run it, so the
 *  suite skips rather than fails: an image build step being absent is not a
 *  regression in this code.
 */

const PROXY = fileURLToPath(
  new URL("../../../../images/egress/proxy.mjs", import.meta.url),
);
const POLICY = fileURLToPath(
  new URL("../../../../images/egress/network.js", import.meta.url),
);

const prepared = existsSync(PROXY) && existsSync(POLICY);

/** An honest end-to-end check of the ALLOWED path needs a public address, and
 *  therefore the internet. Off by default so the suite stays hermetic; worth
 *  running by hand when changing the forwarding code, which the refusal tests
 *  below never reach. */
const withNetwork = process.env["EGRESS_E2E_NETWORK"] === "1";

describe.skipIf(!prepared)("the egress gateway, end to end", () => {
  let proxy: ChildProcessWithoutNullStreams;
  let proxyPort = 0;
  let victim: Server;
  let victimPort = 0;
  let reached = false;

  beforeAll(async () => {
    // Stands in for everything the sandbox network used to be able to reach
    // and now must not: the platform's API, its Postgres, the host's LAN.
    victim = createServer((_req, res) => {
      reached = true;
      res.end("secrets");
    });
    await new Promise<void>((resolve) => {
      victim.listen(0, "127.0.0.1", resolve);
    });
    victimPort = (victim.address() as AddressInfo).port;

    proxy = spawn(process.execPath, [PROXY], {
      // Port 0, and the port it actually took is read back off its own
      // startup line. A fixed port here made this suite flaky: it collides
      // with a leftover process from an earlier run, and the collision
      // surfaces as "the gateway did not start" rather than as what it is.
      env: { ...process.env, EGRESS_PORT: "0" },
      stdio: "pipe",
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the gateway did not start"));
      }, 10_000);
      let line = "";
      proxy.stdout.on("data", (chunk: Buffer) => {
        line += chunk.toString();
        const match = /"event":"egress\.listening","port":(\d+)/.exec(line);
        if (match?.[1]) {
          proxyPort = Number(match[1]);
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }, 20_000);

  afterAll(async () => {
    proxy.kill();
    await new Promise<void>((resolve) => {
      victim.close(() => {
        resolve();
      });
    });
  });

  /** One plain-HTTP proxy request, written by hand because a normal client
   *  would not put an absolute URI in the request line. */
  function proxied(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(proxyPort, "127.0.0.1", () => {
        socket.write(`GET ${url} HTTP/1.1\r\nHost: ignored\r\n\r\n`);
      });
      let body = "";
      socket.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        // Resolved on the headers rather than on close, so a response the
        // gateway chooses to keep alive does not read here as a hang.
        if (body.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(body);
        }
      });
      socket.on("end", () => {
        resolve(body);
      });
      socket.setTimeout(8000, () => {
        socket.destroy();
        reject(new Error("timed out"));
      });
      socket.on("error", reject);
    });
  }

  function tunnelled(authority: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(proxyPort, "127.0.0.1", () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      let head = "";
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString();
        if (head.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(head);
        }
      });
      socket.setTimeout(8000, () => {
        socket.destroy();
        reject(new Error("timed out"));
      });
      socket.on("error", reject);
    });
  }

  describe("what a sandbox cannot reach", () => {
    it("refuses a loopback address, and does not connect to it", async () => {
      reached = false;

      const response = await proxied(`http://127.0.0.1:${String(victimPort)}/`);

      expect(response).toContain("403");
      expect(response).toContain("egress policy");
      // The half that matters. A 403 returned after the request was forwarded
      // would read identically here and would have leaked the response.
      expect(reached).toBe(false);
    });

    it("refuses a NAME that resolves to loopback", async () => {
      // Checking the hostname would pass this; the gateway checks what the
      // name resolved to, which is the only thing a socket ever uses.
      reached = false;

      const response = await proxied(`http://localhost:${String(victimPort)}/`);

      expect(response).toContain("403");
      expect(reached).toBe(false);
    });

    it("refuses the cloud metadata endpoint over CONNECT", async () => {
      // The single most valuable destination on the list: it hands out the
      // deployment's own credentials to anything that can make a request.
      const response = await tunnelled("169.254.169.254:443");

      expect(response).toContain("403");
    });

    it("refuses a port that is not permitted", async () => {
      const response = await tunnelled("example.com:25");

      expect(response).toContain("403");
      expect(response).toContain("25");
    });

    it("answers a malformed proxy request rather than hanging", async () => {
      // A sandbox that can hang the gateway can deny egress to every other
      // project on the host.
      const response = await proxied("/not-absolute");

      expect(response).toContain("400");
    });
  });

  describe.skipIf(!withNetwork)("what a sandbox can reach", () => {
    it("opens a tunnel to a public host", async () => {
      const response = await tunnelled("example.com:443");

      expect(response).toContain("200");
    });
  });
});
