import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Flex, Spin } from "antd";
import { useAuthStore } from "../../store/authStore.ts";

/** Gates a route on a live session.
 *
 *  Waits for `isReady` — set once the boot-time refresh settles — so a hard
 *  reload does not bounce a signed-in user to /login before their access token
 *  has been restored from the refresh cookie.
 */
export const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const { accessToken, isReady } = useAuthStore();
  const location = useLocation();

  if (!isReady) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{ minHeight: "100vh", backgroundColor: "#282a36" }}
      >
        <Spin size="large" />
      </Flex>
    );
  }

  if (!accessToken) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
};
