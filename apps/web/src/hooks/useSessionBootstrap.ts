import { useEffect } from "react";
import { refreshApi } from "../apis/auth.ts";
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
        if (!cancelled) setSession(data.user, data.accessToken);
      } catch {
        // No valid refresh cookie — an ordinary signed-out visit.
        if (!cancelled) clearSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSession, clearSession]);
}
