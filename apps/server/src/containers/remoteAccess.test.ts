import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  env: {
    SANDBOX_SSH_ENABLED: true,
    SANDBOX_SSH_BIND: "127.0.0.1",
    SANDBOX_SSH_HOST: undefined as string | undefined,
  },
}));
vi.mock("../config/env.js", () => envMock);
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  SSH_PORT,
  mappedSshPort,
  remoteAccessFor,
  remoteBinds,
  setupScript,
  sshdConfig,
  startSshd,
  vscodeVolumeName,
} from "./remoteAccess.js";
import { parseSshPublicKeys } from "../lib/sshPublicKey.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function key(comment = "me@laptop") {
  const type = Buffer.from("ssh-ed25519", "ascii");
  const blob = Buffer.concat([
    prefix(type),
    prefix(Buffer.alloc(32, 3)),
  ]).toString("base64");
  return `ssh-ed25519 ${blob} ${comment}`;
}
function prefix(value: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const KEYS = parseSshPublicKeys([key()]);

beforeEach(() => {
  vi.clearAllMocks();
  envMock.env.SANDBOX_SSH_ENABLED = true;
  envMock.env.SANDBOX_SSH_BIND = "127.0.0.1";
  envMock.env.SANDBOX_SSH_HOST = undefined;
});

describe("the daemon's configuration", () => {
  const config = () => sshdConfig();

  it("accepts keys and nothing else", () => {
    expect(config()).toContain("PubkeyAuthentication yes");
    expect(config()).toContain("PasswordAuthentication no");
    expect(config()).toContain("PermitEmptyPasswords no");
  });

  it("refuses every kind of forwarding", () => {
    // A workspace is not a jump host, and with the egress gateway on,
    // forwarding would be a hole straight through it.
    for (const line of [
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PermitTunnel no",
      "GatewayPorts no",
    ]) {
      expect(config()).toContain(line);
    }
  });

  it("does not name an option OpenSSH has removed", () => {
    // Both of these read as the right thing to say and are FATAL on the
    // OpenSSH 9.2 that Debian bookworm ships: an unknown option stops the
    // daemon starting, so saying the true thing would have broken every
    // attach. There is nothing to see at runtime -- only this test.
    expect(config()).not.toContain("UsePrivilegeSeparation");
    expect(config()).not.toContain("ChallengeResponseAuthentication");
  });

  it("keeps sftp, which is how an editor reads and writes files", () => {
    expect(config()).toContain("Subsystem sftp internal-sftp");
  });

  it("listens on the one port the whole system agrees on", () => {
    expect(config()).toContain(`Port ${String(SSH_PORT)}`);
    expect(SSH_PORT).toBeGreaterThan(1024);
  });
});

describe("the setup script", () => {
  it("generates a host key only when there is not one", () => {
    // A host key that changed on every start gives every reconnect the
    // "REMOTE HOST IDENTIFICATION HAS CHANGED" wall, which trains people to
    // delete known_hosts -- and that warning has to keep meaning something.
    expect(setupScript(KEYS)).toContain("if [ ! -f /home/sandbox/.ssh/ssh_host_ed25519_key ]");
  });

  it("quotes the heredocs, so a key comment cannot become a command", () => {
    // The comment is user input and it is carried through a shell.
    expect(setupScript(KEYS)).toContain("<<'RC_EOF_KEYS'");
    expect(setupScript(KEYS)).toContain("<<'RC_EOF_CONF'");
  });

  it("does not let a comment escape the heredoc", () => {
    const hostile = parseSshPublicKeys([key("$(touch /tmp/pwned)")]);
    const script = setupScript(hostile);
    // Present as text, and inside a quoted heredoc, so it is never expanded.
    expect(script).toContain("$(touch /tmp/pwned)");
    expect(script).toContain("<<'RC_EOF_KEYS'");
  });

  it("locks the permissions sshd insists on", () => {
    expect(setupScript(KEYS)).toContain("chmod 700 /home/sandbox/.ssh");
    expect(setupScript(KEYS)).toContain("chmod 600 /home/sandbox/.ssh/authorized_keys");
  });

  it("restarts rather than starts, so a new key takes effect", () => {
    expect(setupScript(KEYS)).toContain("kill");
    expect(setupScript(KEYS)).toContain("/usr/sbin/sshd -f");
  });
});

describe("what the container gets mounted", () => {
  it("gives ~/.vscode-server a volume", () => {
    // The spike measured 1.3 GB after one extension pack, in the writable
    // layer that every environment-signature change throws away. Without this
    // an attach re-downloads 229 MB on each rebuild.
    expect(remoteBinds(PROJECT)).toEqual([
      `${vscodeVolumeName(PROJECT)}:/home/sandbox/.vscode-server`,
    ]);
  });

  it("mounts nothing when the deployment does not use this", () => {
    envMock.env.SANDBOX_SSH_ENABLED = false;
    expect(remoteBinds(PROJECT)).toEqual([]);
  });
});

describe("reading the mapped port", () => {
  it("takes the host port Docker chose", () => {
    expect(
      mappedSshPort({ "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] }),
    ).toBe(49155);
  });

  it("is null when nothing is published", () => {
    expect(mappedSshPort({})).toBeNull();
    expect(mappedSshPort(undefined)).toBeNull();
  });

  it("is null rather than NaN when the value is nonsense", () => {
    expect(
      mappedSshPort({ "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }),
    ).toBeNull();
  });
});

describe("what somebody is told", () => {
  const base = { running: true, keyCount: 1, port: 49155 };

  it("hands back a command and a URI that open the workspace", () => {
    const access = remoteAccessFor({ ...base, requestHost: "box.example" });
    expect(access.command).toBe("ssh -p 49155 sandbox@box.example");
    // The folder, not a prompt: somebody attaching an editor wants the project.
    expect(access.vscodeUri).toContain("/home/sandbox/app");
    expect(access.vscodeUri).toContain("ssh-remote+sandbox@box.example:49155");
  });

  it("prefers the operator's hostname over the request's", () => {
    // A server behind a proxy has no idea of its own public name.
    envMock.env.SANDBOX_SSH_HOST = "dev.example.com";
    expect(remoteAccessFor({ ...base, requestHost: "internal" }).host).toBe(
      "dev.example.com",
    );
  });

  it("says which of the four reasons it is unavailable", () => {
    expect(remoteAccessFor({ ...base, keyCount: 0 }).reason).toBe("no-key");
    expect(remoteAccessFor({ ...base, running: false }).reason).toBe("not-running");
    expect(remoteAccessFor({ ...base, port: null }).reason).toBe("no-port");

    envMock.env.SANDBOX_SSH_ENABLED = false;
    expect(remoteAccessFor(base).reason).toBe("disabled");
  });

  it("checks the deployment before the account, so an operator's answer wins", () => {
    // "You have no key" on a server that would ignore it is a wrong answer
    // that sends somebody to generate one.
    envMock.env.SANDBOX_SSH_ENABLED = false;
    expect(remoteAccessFor({ ...base, keyCount: 0 }).reason).toBe("disabled");
  });
});

describe("starting it", () => {
  function fakeContainer(exitCode = 0) {
    const stream = {
      on: (event: string, handler: (chunk?: unknown) => void) => {
        if (event === "end") setTimeout(handler, 0);
        return stream;
      },
    };
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: exitCode }),
    };
    return {
      container: { exec: vi.fn().mockResolvedValue(exec) },
      exec,
    };
  }

  it("does nothing when the account has no key", async () => {
    // An sshd nobody can log into is a port open for no reason.
    const { container } = fakeContainer();
    await expect(
      startSshd(container as never, PROJECT, []),
    ).resolves.toBe(false);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("does nothing when the deployment has it off", async () => {
    envMock.env.SANDBOX_SSH_ENABLED = false;
    const { container } = fakeContainer();
    await expect(startSshd(container as never, PROJECT, KEYS)).resolves.toBe(false);
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("reports failure instead of throwing", async () => {
    // An older image without openssh-server, or a full disk. A workspace that
    // cannot run sshd must still open in the browser.
    const { container } = fakeContainer(127);
    await expect(startSshd(container as never, PROJECT, KEYS)).resolves.toBe(false);
  });

  it("swallows a docker error rather than failing the start", async () => {
    const container = { exec: vi.fn().mockRejectedValue(new Error("no daemon")) };
    await expect(startSshd(container as never, PROJECT, KEYS)).resolves.toBe(false);
  });

  it("runs the script and says so when it worked", async () => {
    const { container, exec } = fakeContainer(0);
    await expect(startSshd(container as never, PROJECT, KEYS)).resolves.toBe(true);
    expect(exec.start).toHaveBeenCalled();
  });
});
