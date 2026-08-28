import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { lookup } from "node:dns/promises";
import { egressDecision } from "./network.js";

/** The only way out of the sandbox network.
 *
 *  The sandbox bridge is created with `Internal: true`, which means Docker
 *  adds no route off it and no NAT. A project container therefore cannot
 *  reach anything at all by itself -- not the internet, not the host, not the
 *  platform's own database. This process is attached to that network AND to a
 *  second, ordinary one, and forwards on the sandbox's behalf.
 *
 *  That asymmetry is the whole design, and it is why the proxy environment
 *  variables handed to project containers are a CONVENIENCE rather than the
 *  control. Code that respects `HTTPS_PROXY` gets a working `npm install`.
 *  Code that ignores it -- which is exactly what hostile code would do --
 *  finds no route and fails. The policy is enforced by the topology; the
 *  variables only make the permitted path discoverable.
 *
 *  This file is deliberately I/O and nothing else. Every decision about where
 *  a sandbox may go lives in `egressDecision`, which is pure, shared with the
 *  server's own SSRF guard, and tested there -- because a security rule that
 *  can only be exercised by standing up a container and a network is a
 *  security rule nobody tests.
 */

const PORT = Number(process.env["EGRESS_PORT"] ?? 3128);

const POLICY = {
  allowDomains: (process.env["EGRESS_ALLOW_DOMAINS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  allowPorts: (process.env["EGRESS_ALLOW_PORTS"] ?? "80,443,9418")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0),
};

/** Resolves a destination, then asks the shared policy about it. */
async function check(host, port) {
  let addresses;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    // A literal address needs no lookup, and putting one through DNS would
    // only give the resolver a chance to say something else.
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map(
        (entry) => entry.address,
      );
    } catch {
      addresses = [];
    }
  }

  return egressDecision(host, port, addresses, POLICY);
}

function refuse(reason, detail) {
  // One line per refusal, on stdout, because the operator's first question
  // after "my install failed" is which destination was blocked.
  console.log(JSON.stringify({ event: "egress.denied", reason, detail }));
}

function splitAuthority(authority, defaultPort) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracketed) {
    return { host: bracketed[1], port: Number(bracketed[2]) || defaultPort };
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return { host: authority, port: defaultPort };
  const port = Number(authority.slice(colon + 1));
  if (!Number.isInteger(port)) return { host: authority, port: defaultPort };
  return { host: authority.slice(0, colon), port };
}

const server = createServer();

/** Plain HTTP, where the request line carries an absolute URI. */
server.on("request", (req, res) => {
  void (async () => {
    let target;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { Connection: "close" }).end("Malformed proxy request.\n");
      return;
    }

    if (target.protocol !== "http:") {
      res
        .writeHead(400, { Connection: "close" })
        .end("Only http:// is proxied directly; use CONNECT.\n");
      return;
    }

    const port = Number(target.port) || 80;
    const verdict = await check(target.hostname, port);

    if (!verdict.allowed) {
      refuse(verdict.reason, `${req.method ?? "?"} ${target.hostname}:${port}`);
      res.writeHead(403, {
        "Content-Type": "text/plain",
        // A refusal ends the conversation. Left keep-alive, a client that
        // reads the headers and waits for the body it was promised waits
        // for a connection that is never going anywhere.
        Connection: "close",
      });
      res.end(`Blocked by the sandbox egress policy: ${verdict.reason}\n`);
      return;
    }

    const upstream = netConnect(port, verdict.address, () => {
      const path = `${target.pathname}${target.search}`;
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        // Hop-by-hop: ours to terminate, not to forward.
        if (/^proxy-/i.test(req.rawHeaders[i])) continue;
        headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(
        `${req.method} ${path} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      req.pipe(upstream);
    });

    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { Connection: "close" }).end("Upstream unreachable.\n");
      } else res.destroy();
    });

    upstream.pipe(res.socket ?? res);
  })();
});

/** HTTPS, and anything else tunnelled.
 *
 *  The bytes are opaque once the tunnel is open -- this cannot and should not
 *  inspect TLS. What it can do is decide, before a single byte passes,
 *  whether the destination is one a sandbox may reach at all. That is the
 *  check that matters; reading the traffic would not add one.
 */
server.on("connect", (req, clientSocket, head) => {
  void (async () => {
    const { host, port } = splitAuthority(req.url ?? "", 443);
    const verdict = await check(host, port);

    if (!verdict.allowed) {
      refuse(verdict.reason, `CONNECT ${host}:${port}`);
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n" +
          `Blocked by the sandbox egress policy: ${verdict.reason}\n`,
      );
      return;
    }

    const upstream = netConnect(port, verdict.address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    clientSocket.on("error", () => {
      upstream.destroy();
    });
  })();
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "egress.listening",
      port: PORT,
      allowDomains: POLICY.allowDomains.length === 0 ? "any public" : POLICY.allowDomains,
      allowPorts: POLICY.allowPorts,
    }),
  );
});
