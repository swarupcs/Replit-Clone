import axios from "axios";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";
import type { AuthResponse } from "@replit-clone/shared";
import { useAuthStore } from "../store/authStore.ts";

const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_BACKEND_URL,
  // Required for the httpOnly refresh cookie to travel cross-origin.
  withCredentials: true,
});

axiosInstance.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

/** Shared across concurrent 401s so a burst of requests triggers ONE refresh
 *  rather than a stampede that invalidates itself. */
let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  refreshInFlight ??= axios
    .post<AuthResponse>(
      `${import.meta.env.VITE_BACKEND_URL}/api/v1/auth/refresh`,
      {},
      { withCredentials: true },
    )
    .then((response) => {
      const { user, accessToken } = response.data.data;
      useAuthStore.getState().setSession(user, accessToken);
      return accessToken;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;

    const isAuthEndpoint = config?.url?.includes("/api/v1/auth/");

    if (error.response?.status !== 401 || !config || config._retried || isAuthEndpoint) {
      return Promise.reject(error);
    }

    config._retried = true;

    try {
      const token = await refreshAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return axiosInstance(config);
    } catch (refreshError) {
      useAuthStore.getState().clearSession();
      // Normalised so callers always get an Error with a usable stack, rather
      // than whatever value the refresh happened to throw.
      return Promise.reject(
        refreshError instanceof Error
          ? refreshError
          : new Error("Could not refresh the session"),
      );
    }
  },
);

export default axiosInstance;
