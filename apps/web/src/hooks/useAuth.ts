import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { Credentials } from "@replit-clone/shared";
import { loginApi, logoutApi, signupApi } from "../apis/auth.ts";
import { useAuthStore } from "../store/authStore.ts";
import { queryClient } from "../config/queryClient.ts";

export function useAuth() {
  const { user, accessToken, isReady, setSession, clearSession } =
    useAuthStore();
  const navigate = useNavigate();

  const login = useCallback(
    async (credentials: Credentials) => {
      const { data } = await loginApi(credentials);
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
    signup,
    logout,
  };
}
