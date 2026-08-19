import { create } from "zustand";
import type { PublicUser } from "@replit-clone/shared";

interface AuthStore {
  user: PublicUser | null;
  /** Held in memory only. The refresh token lives in an httpOnly cookie the
   *  page cannot read, so a XSS payload cannot exfiltrate a long-lived
   *  credential from localStorage. */
  accessToken: string | null;
  /** False until the initial refresh attempt settles, so ProtectedRoute does
   *  not bounce a signed-in user to /login on a hard reload. */
  isReady: boolean;
  setSession: (user: PublicUser, accessToken: string) => void;
  clearSession: () => void;
  setReady: (isReady: boolean) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  accessToken: null,
  isReady: false,
  setSession: (user, accessToken) => set({ user, accessToken, isReady: true }),
  clearSession: () => set({ user: null, accessToken: null, isReady: true }),
  setReady: (isReady) => set({ isReady }),
}));

/** Non-hook accessor for interceptors and socket setup. */
export const getAccessToken = (): string | null =>
  useAuthStore.getState().accessToken;
