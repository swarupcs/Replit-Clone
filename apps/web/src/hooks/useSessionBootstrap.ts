import { useEffect } from "react";
import { meApi, refreshApi } from "../apis/auth.ts";
import { useAuthStore } from "../store/authStore.ts";

/** Restores a session on first load from the httpOnly refresh cookie.
 *
 *  The access token is deliberately memory-only, so it is gone after a reload;
 *  this exchanges the surviving refresh cookie for a fresh one.
 */
export function useSessionBootstrap(): void {
  const { setSession, clearSession } = useAuthStore();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { data } = await refreshApi();
        if (cancelled) return;

        setSession(data.user, data.accessToken);

        // Confirms the restored token is accepted, and picks up an account
        // whose details changed while the tab was closed. Refresh tokens can
        // now be revoked server-side, so a session that looks restorable is
        // not necessarily still live.
        const user = await meApi();
        if (!cancelled) setSession(user, data.accessToken);
      } catch {
        // No valid refresh cookie, or a session that has since been revoked —
        // an ordinary signed-out visit either way.
        if (!cancelled) clearSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSession, clearSession]);
}
