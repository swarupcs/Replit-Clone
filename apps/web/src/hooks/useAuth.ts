import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { Credentials } from "@replit-clone/shared";
import {
  loginApi,
  loginTotpApi,
  logoutApi,
  signupApi,
} from "../apis/auth.ts";
import { isMfaChallenge } from "@replit-clone/shared";
import { useAuthStore } from "../store/authStore.ts";
import { queryClient } from "../config/queryClient.ts";

export function useAuth() {
  const { user, accessToken, isReady, setSession, clearSession } =
    useAuthStore();
  const navigate = useNavigate();

  /** Signs in, or reports that a code is still needed.
   *
   *  Returns the challenge token rather than storing it, so a half-finished
   *  sign-in leaves nothing behind in the session store: closing the tab at
   *  the code step is the same as never having started. plan.md §11.6.
   */
  const login = useCallback(
    async (credentials: Credentials): Promise<string | null> => {
      const response = await loginApi(credentials);
      if (isMfaChallenge(response)) return response.data.mfaToken;

      setSession(response.data.user, response.data.accessToken);
      return null;
    },
    [setSession],
  );

  const completeTotp = useCallback(
    async (mfaToken: string, code: string) => {
      const { data } = await loginTotpApi(mfaToken, code);
      setSession(data.user, data.accessToken);
    },
    [setSession],
  );

  const signup = useCallback(
    async (credentials: Credentials) => {
      const { data } = await signupApi(credentials);
      setSession(data.user, data.accessToken);
    },
    [setSession],
  );

  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } finally {
      clearSession();
      // Otherwise the next user to sign in sees the previous one's cached
      // project list before the refetch lands.
      queryClient.clear();
      void navigate("/login");
    }
  }, [clearSession, navigate]);

  return {
    user,
    isAuthenticated: Boolean(accessToken),
    isReady,
    login,
    completeTotp,
    signup,
    logout,
  };
}
