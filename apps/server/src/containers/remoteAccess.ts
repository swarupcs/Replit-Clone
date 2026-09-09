import type Dockerode from "dockerode";
import type { RemoteAccess, SshKey } from "@replit-clone/shared";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { authorizedKeysFile } from "../lib/sshPublicKey.js";
import { assertValidProjectId } from "../utils/projectPaths.js";

/** Attaching your own editor to a workspace over SSH. plan.md §10.1 Route C,
 *  §14.2's Phase 1b.
 *
 *  **What §10.1 decided and this builds.** Monaco stays as the browser editor;
 *  the workspace becomes attachable, so somebody's own VS Code, Cursor, Zed or
 *  `nvim` opens it directly. The spike established that this reaches 10.6
 *  (debugging) and 10.7 (extensions) — the two rows Monaco can never reach —
 *  for 7 MB of image and one volume.
 *
 *  **The security posture is the one that already exists, not a new one.**
 *  `sshd` runs as uid 1001 with `CapDrop: ["ALL"]` and `no-new-privileges`,
 *  on a high port, with a host key in the home directory. No root, no setuid,
 *  no privilege separation — because the user it authenticates is the user it
 *  already runs as. That is the whole reason this is affordable: a normal sshd
 *  wants root to change uid, and this one never changes uid.
 *
 *  **Two things the spike found the expensive way, and both are handled here.**
 *
 *  1. `~/.vscode-server` reached 1.3 GB after one extension pack, and it landed
 *     in the container's writable layer — which `reconcileOnBoot` and every
 *     environment-signature change throw away. Attaching would have
 *     re-downloaded 229 MB and reinstalled every extension on each rebuild. It
 *     gets a named volume, exactly as the package cache did.
 *  2. The spike ran on the default bridge with a published port, NOT on
 *     `SANDBOX_NETWORK` behind the egress gateway — and that 229 MB download is
 *     the first thing a filtered sandbox refuses. `SSH_EGRESS_NOTE` below is
 *     what an operator is told about it, because the alternative is somebody
 *     debugging a silent hang in a client they cannot see the logs of.
 */

/** Inside the container. Fixed, not configurable: it is behind a per-container
 *  port mapping anyway, and one number the whole system agrees on is worth more
 *  than a knob nobody turns. Above 1024 so no capability is needed to bind it. */
export const SSH_PORT = 2222;

/** Where the sandbox's home is. Matches the image's `useradd --create-home`. */
const HOME = "/home/sandbox";

/** The workspace itself, which is what a client should open rather than the
 *  home directory. */
export const REMOTE_FOLDER = `${HOME}/app`;

/** The account inside the container. One user, because the container IS one
 *  person's workspace. */
export const SSH_USER = "sandbox";

const VSCODE_VOLUME_PREFIX = "rc-vscode-";

/** Named volume for `~/.vscode-server`, so an attached editor survives a
 *  container rebuild. See the note above for what it costs when it does not. */
export function vscodeVolumeName(projectId: string): string {
  return `${VSCODE_VOLUME_PREFIX}${assertValidProjectId(projectId)}`;
}

/** What a container needs mounted for Route C. Empty when SSH is off, so a
 *  deployment that does not use this does not carry a volume per project. */
export function remoteBinds(projectId: string): string[] {
  if (!env.SANDBOX_SSH_ENABLED) return [];
  return [`${vscodeVolumeName(projectId)}:${HOME}/.vscode-server`];
}

/** Told to an operator rather than discovered by a user. */
export const SSH_EGRESS_NOTE =
  "An attached VS Code downloads its own server (~230 MB) on first connect. " +
  "On a deployment with egress filtering on, allow update.code.visualstudio.com " +
  "and marketplace.visualstudio.com or the client will hang with no error.";

/** The sshd configuration, generated rather than baked into the image.
 *
 *  Written as a file the daemon is pointed at, so nothing in the image has to
 *  be edited in place and so what is running can be read back verbatim. Every
 *  line here is a refusal:
 *
 *  - No password authentication of any kind, and no empty passwords. The
 *    sandbox user has no password set, and `PermitEmptyPasswords no` means a
 *    misconfiguration cannot turn that into an open door.
 *  - No TCP or agent or X11 forwarding. A workspace is not a jump host, and
 *    forwarding is how a sandbox behind an egress gateway becomes a way around
 *    it — the one thing this platform's network policy exists to prevent.
 *  - `AllowUsers sandbox`, because there is exactly one account here.
 */
export function sshdConfig(): string {
  return [
    `Port ${String(SSH_PORT)}`,
    "AddressFamily any",
    "ListenAddress 0.0.0.0",
    `HostKey ${HOME}/.ssh/ssh_host_ed25519_key`,
    // Not root, and not a second user later: one workspace, one account.
    "AllowUsers sandbox",
    "PermitRootLogin no",
    "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${HOME}/.ssh/authorized_keys`,
    "PasswordAuthentication no",
    "PermitEmptyPasswords no",
    "KbdInteractiveAuthentication no",
    // NOT `ChallengeResponseAuthentication`, which OpenSSH renamed to the line
    // above and REMOVED in 8.7. Debian bookworm ships 9.2, where an unknown
    // option is a fatal error -- so the deprecated spelling would not be a
    // harmless duplicate, it would stop the daemon starting at all.
    "UsePAM no",
    // A workspace is not a jump host. With the egress gateway on, forwarding
    // would be a hole straight through it.
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "GatewayPorts no",
    // sftp is what an editor uses to read and write files, so it stays.
    "Subsystem sftp internal-sftp",
    // There is deliberately no `UsePrivilegeSeparation` line. It reads as the
    // right thing to say -- this runs as the user it authenticates, so there
    // is no privilege to separate -- but OpenSSH deprecated it in 7.5 and
    // REMOVED it in 8.0, and 9.2 treats an unknown option as fatal. Saying the
    // true thing would have stopped the daemon from starting.
    "PidFile /tmp/sshd.pid",
    "LogLevel INFO",
    "",
  ].join("\n");
}

/** The one-shot script that makes a container attachable.
 *
 *  Idempotent on purpose — it runs on every start, and a start is also what
 *  happens after somebody adds a key. Generating the host key only when absent
 *  is what makes the volume worth having: a host key that changed on every
 *  start would give every reconnect the client's "REMOTE HOST IDENTIFICATION
 *  HAS CHANGED" wall of text, which trains people to delete their known_hosts
 *  and is exactly the warning that should mean something.
 */
export function setupScript(keys: readonly SshKey[]): string {
  const config = sshdConfig();
  const authorized = authorizedKeysFile(keys);

  return [
    "set -e",
    `mkdir -p ${HOME}/.ssh`,
    `chmod 700 ${HOME}/.ssh`,
    // Heredocs quoted so nothing inside is expanded by the shell that carries
    // it -- a key's comment is user input and must not become a command.
    `cat > ${HOME}/.ssh/authorized_keys <<'RC_EOF_KEYS'`,
    authorized,
    "RC_EOF_KEYS",
    `chmod 600 ${HOME}/.ssh/authorized_keys`,
    `cat > ${HOME}/.ssh/sshd_config <<'RC_EOF_CONF'`,
    config,
    "RC_EOF_CONF",
    // Only when absent. See above: a rotating host key is a warning nobody
    // reads twice.
    `if [ ! -f ${HOME}/.ssh/ssh_host_ed25519_key ]; then`,
    `  ssh-keygen -q -t ed25519 -N '' -f ${HOME}/.ssh/ssh_host_ed25519_key`,
    "fi",
    `chmod 600 ${HOME}/.ssh/ssh_host_ed25519_key`,
    // Restart rather than start, so a config or key change takes effect
    // without waiting for the container to be rebuilt.
    "if [ -f /tmp/sshd.pid ]; then kill \"$(cat /tmp/sshd.pid)\" 2>/dev/null || true; fi",
    `/usr/sbin/sshd -f ${HOME}/.ssh/sshd_config`,
    "",
  ].join("\n");
}

/** Writes the keys in and starts the daemon.
 *
 *  Never throws. An editor you can attach is an addition to a workspace, not a
 *  precondition for one: a container that cannot start sshd — an older image
 *  without `openssh-server`, a full disk — must still open in the browser.
 *  Logged at warn so an operator can see it, and reported through
 *  `remoteAccessFor` as `failed` so the person is told rather than left
 *  wondering why their client times out.
 */
export async function startSshd(
  container: Dockerode.Container,
  projectId: string,
  keys: readonly SshKey[],
): Promise<boolean> {
  if (!env.SANDBOX_SSH_ENABLED) return false;

  // No key means nothing could authenticate anyway, and an sshd nobody can log
  // into is a port open for no reason.
  if (keys.length === 0) return false;

  try {
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", setupScript(keys)],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });

    // Drained rather than ignored: an exec whose output nobody reads can block
    // once the buffer fills, and this one runs on every container start.
    await new Promise<void>((resolve) => {
      stream.on("data", () => {});
      stream.on("end", resolve);
      stream.on("error", resolve);
    });

    const result = await exec.inspect();
    if (result.ExitCode !== 0) {
      logger.warn("could not start sshd in sandbox", {
        projectId,
        exitCode: result.ExitCode,
      });
      return false;
    }

    logger.info("sandbox is attachable over ssh", { projectId, keys: keys.length });
    return true;
  } catch (error) {
    logger.warn("could not start sshd in sandbox", { projectId, error });
    return false;
  }
}

/** Reads the host port Docker mapped `SSH_PORT` to.
 *
 *  Asked of Docker rather than remembered, because the mapping is Docker's to
 *  choose (`HostPort: "0"`) and a container that restarted has a different one.
 *  A remembered number here would be a connection refused that looks like a
 *  firewall.
 */
export function mappedSshPort(
  ports: Dockerode.ContainerInspectInfo["NetworkSettings"]["Ports"] | undefined,
): number | null {
  const binding = ports?.[`${String(SSH_PORT)}/tcp`];
  const first = binding?.[0]?.HostPort;
  if (first === undefined) return null;

  const port = Number(first);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** What to tell somebody who wants to attach.
 *
 *  `host` is the honest hard part: a server does not know its own public name,
 *  and guessing produces a command that fails for everybody behind a proxy. So
 *  an operator sets `SANDBOX_SSH_HOST` when there is one, and otherwise the
 *  caller passes the hostname the browser itself used — which is right far more
 *  often than any constant would be.
 */
export function remoteAccessFor(options: {
  running: boolean;
  keyCount: number;
  port: number | null;
  requestHost?: string;
}): RemoteAccess {
  if (!env.SANDBOX_SSH_ENABLED) return { available: false, reason: "disabled" };
  if (options.keyCount === 0) return { available: false, reason: "no-key" };
  if (!options.running) return { available: false, reason: "not-running" };
  if (options.port === null) return { available: false, reason: "no-port" };

  const host = env.SANDBOX_SSH_HOST ?? options.requestHost ?? "localhost";
  const port = options.port;

  return {
    available: true,
    host,
    port,
    user: SSH_USER,
    folder: REMOTE_FOLDER,
    command: `ssh -p ${String(port)} ${SSH_USER}@${host}`,
    // The URI VS Code's Remote-SSH extension registers. Opening the folder
    // rather than a shell, because a person attaching an editor wants the
    // project, not a prompt.
    vscodeUri: `vscode://vscode-remote/ssh-remote+${SSH_USER}@${host}:${String(port)}${REMOTE_FOLDER}`,
  };
}
