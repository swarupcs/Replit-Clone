import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelServerMessage } from "@replit-clone/shared";
import { useAuthStore } from "../store/authStore.ts";
import {
  KernelClient,
  kernelSocketUrl,
  type KernelState,
} from "../lib/kernelClient.ts";

/** Owns one kernel connection for one open notebook. plan.md §12.3.
 *
 *  Modelled on `useLanguageServer`, with one deliberate difference that is the
 *  whole reason it is a hook rather than a `useEffect` in the component: **a
 *  kernel is not started by opening the file.** The language server connects
 *  as soon as a Python file is on screen, which is right for something that
 *  only reads. A kernel starts a process in a container and holds memory for
 *  as long as the tab is open, so it connects on the first Run and not before
 *  — opening a notebook to read it costs nothing.
 *
 *  `KernelClient.send` already implements that: it connects on the first send
 *  and queues until the socket opens. This hook exists to tie that lifetime to
 *  a React component, to keep the token read imperative (it rotates, and
 *  reconnecting a warm kernel every fifteen minutes would throw away the
 *  user's variables), and to give `restart` somewhere to live.
 */

export interface UseKernelOptions {
  projectId: string;
  /** From the notebook's own `metadata.kernelspec.language`. The server
   *  refuses one it has no kernel for, with a message. */
  language: string;
  /** Every message, in arrival order. Held in a ref so a caller does not have
   *  to memoise it to avoid tearing down the kernel on every render. */
  onMessage: (message: KernelServerMessage) => void;
}

export interface Kernel {
  state: KernelState;
  /** Why it failed, when the gateway said. */
  error: string | null;
  execute: (cellId: string, code: string) => void;
  interrupt: () => void;
  /** Drops the connection and forgets every variable. The next Run starts a
   *  fresh one, by the same path a first Run takes. */
  restart: () => void;
}

export function useKernel(options: UseKernelOptions): Kernel {
  const { projectId, language, onMessage } = options;

  const [state, setState] = useState<KernelState>("idle");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<KernelClient | null>(null);

  /** So the client is built once per notebook rather than once per render. */
  const handler = useRef(onMessage);
  handler.current = onMessage;

  /** Whether a session exists at all -- not its value. Same reasoning as
   *  `useLanguageServer`: reading the token here would rebuild the client
   *  every time it rotated. */
  const hasSession = useAuthStore((entry) => entry.accessToken !== null);

  useEffect(() => {
    if (!projectId || !language || !hasSession) return;

    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    let disposed = false;

    const client = new KernelClient(
      kernelSocketUrl(projectId, language, token),
      {
        onMessage: (message) => {
          if (disposed) return;
          handler.current(message);
        },
        onState: (next, reason) => {
          if (disposed) return;
          setState(next);
          // Only ever set alongside a failure, and cleared by the next state
          // that is not one -- so a kernel that failed and was restarted does
          // not keep explaining the failure before last.
          setError(next === "failed" ? (reason ?? null) : null);
        },
      },
    );

    clientRef.current = client;

    return () => {
      disposed = true;
      client.dispose();
      clientRef.current = null;
      // Back to where a freshly opened notebook starts, so switching away and
      // back does not show the previous tab's "busy".
      setState("idle");
      setError(null);
    };
    // `restartTick` is not a dependency: restarting replaces the client
    // through `restart` below rather than by re-running this effect, so that
    // a token rotation and a restart cannot race for the same socket.
  }, [projectId, language, hasSession]);

  const execute = useCallback((cellId: string, code: string) => {
    clientRef.current?.send({ type: "execute", cellId, code });
  }, []);

  const interrupt = useCallback(() => {
    clientRef.current?.send({ type: "interrupt" });
  }, []);

  const restart = useCallback(() => {
    // Told, rather than dropped. A kernel that is merely disconnected leaves
    // the process running in the container holding its memory, which is the
    // one thing restarting is supposed to release.
    clientRef.current?.send({ type: "restart" });
  }, []);

  return { state, error, execute, interrupt, restart };
}
