import type { Request, Response } from "express";
import type { AccountSshKeys, RemoteAccess } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { env } from "../config/env.js";
import {
  accountSshKeys,
  getAccountSshKeys,
  setAccountSshKeys,
} from "../service/accountSshKeyService.js";
import {
  mappedSshPort,
  remoteAccessFor,
} from "../containers/remoteAccess.js";
import { inspectProjectContainer } from "../containers/containerManager.js";
import { assertProjectAccess } from "../service/projectAccessService.js";

/** Keys, and how to attach with them. plan.md §10.1 Route C.
 *
 *  Session-only, like everything on the account router. Sharper here than
 *  elsewhere: a key added through this endpoint can open a shell in every
 *  workspace the account owns, so an API key that could write it would be one
 *  credential that grants a persistent, revocation-surviving second one.
 */

function body(keys: Awaited<ReturnType<typeof getAccountSshKeys>>): AccountSshKeys {
  return { keys, enabled: env.SANDBOX_SSH_ENABLED };
}

export async function getSshKeysController(
  req: Request,
  res: Response,
): Promise<void> {
  const keys = await getAccountSshKeys(getAuthContext(req).userId);
  res.json({ success: true, message: "SSH keys", data: body(keys) });
}

export async function setSshKeysController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const lines: unknown = (req.body as { lines?: unknown } | undefined)?.lines ?? [];
  const keys = await setAccountSshKeys(userId, lines);
  res.json({ success: true, message: "SSH keys saved", data: body(keys) });
}

/** How to reach one workspace with your own editor.
 *
 *  Per project rather than per account, because the port is per container and
 *  Docker chooses it -- see `mappedSshPort` for why it is asked rather than
 *  remembered.
 */
export async function getRemoteAccessController(
  req: Request,
  res: Response,
): Promise<void> {
  const { projectId } = req.params as { projectId: string };

  // Owner, not editor. The keys this answers about are the OWNER's, and the
  // command it returns opens a shell as the sandbox user -- so anybody who can
  // read this can attach with a key they did not add. A collaborator has a
  // terminal in the browser and that is a different thing: it ends when their
  // access does.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "owner");

  const [keys, info] = await Promise.all([
    accountSshKeys(projectId),
    inspectProjectContainer(projectId),
  ]);

  const access: RemoteAccess = remoteAccessFor({
    running: info?.State.Running ?? false,
    keyCount: keys.length,
    port: mappedSshPort(info?.NetworkSettings.Ports),
    // The hostname the browser itself used. A server behind a proxy has no
    // idea of its own public name, and this is right far more often than any
    // constant -- SANDBOX_SSH_HOST overrides it where it is wrong.
    requestHost: req.hostname,
  });

  res.json({ success: true, message: "Remote access", data: access });
}
