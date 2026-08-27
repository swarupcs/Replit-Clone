import { useEffect } from "react";
import { meApi } from "../apis/auth.ts";
import { refreshAccessToken } from "../config/axiosConfig.ts";
import { useAuthStore } from "../store/authStore.ts";

/** Restores a session on first load from the httpOnly refresh cookie.
 *
 *  The access token is deliberately memory-only, so it is gone after a reload;
 *  this exchanges the surviving refresh cookie for a fresh one.
 *
 *  `enabled` exists for the embed route, and the reason is worth stating: a
 *  refresh token is SINGLE USE and rotates on every exchange. An embed runs in
 *  an iframe on somebody else's site, where the browser may hand over the
 *  reader's cookie (a deployment with COOKIE_SAME_SITE=none) and then refuse to
 *  store the replacement, because storage in a third-party frame is
 *  partitioned. The old token is spent, the new one is lost, and the session
 *  the reader has open in their real tab is dead -- so embedding a project
 *  would quietly sign people out of it. Nothing on that page needs a session
 *  anyway.
 */
export function useSessionBootstrap(enabled = true): void {
  const { setSession, clearSession } = useAuthStore();

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    void (async () => {
      try {
        // Through the shared de-duplicated refresher: React StrictMode invokes
        // this effect twice on mount, and two independent refreshes would
        // present the single-use refresh token twice -- a replay that revokes
        // the whole family and logs the user straight back out. The shared
        // in-flight promise collapses the pair into one request. It also sets
        // the session (user + token) on success.
        const accessToken = await refreshAccessToken();
        if (cancelled) return;

        // Confirms the restored token is accepted, and picks up an account
        // whose details changed while the tab was closed. Refresh tokens can
        // now be revoked server-side, so a session that looks restorable is
        // not necessarily still live.
        const user = await meApi();
        if (!cancelled) setSession(user, accessToken);
      } catch {
        // No valid refresh cookie, or a session that has since been revoked —
        // an ordinary signed-out visit either way.
        if (!cancelled) clearSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, setSession, clearSession]);
}
