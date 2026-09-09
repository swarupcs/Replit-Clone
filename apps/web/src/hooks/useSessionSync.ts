import { useEffect } from "react";
import { useAuthStore } from "../store/authStore.ts";
import {
  forgetSeenRevs,
  startSessionSync,
  stopSessionSync,
} from "../lib/sessionSync.ts";

/** Keeps this browser's editor session and the account's in step.
 *  plan.md §13.11.
 *
 *  Started when somebody signs in and stopped when they sign out, because
 *  every request it makes needs a session and a signed-out browser pushing
 *  settings is a 401 on a timer.
 *
 *  Restarted when the ACCOUNT changes, not merely when a token does: two
 *  people sharing a browser must not inherit each other's layout, and the
 *  revisions this browser has seen belong to whoever was signed in when it saw
 *  them.
 */
export function useSessionSync(enabled = true): void {
  const userId = useAuthStore((state) => state.user?.id ?? null);

  useEffect(() => {
    if (!enabled || userId === null) return;

    startSessionSync(userId);
    return () => {
      stopSessionSync();
    };
  }, [enabled, userId]);

  useEffect(() => {
    // On the way OUT of an account rather than into one, so the next sign-in
    // starts without the previous account's revision numbers -- which would
    // otherwise make its stored session look like one this browser had already
    // applied, and it would never be pulled.
    return () => {
      forgetSeenRevs();
    };
  }, [userId]);
}
