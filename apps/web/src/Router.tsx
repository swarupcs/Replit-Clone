import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Flex, Spin } from "antd";
import { ErrorBoundary } from "./components/routing/ErrorBoundary.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Login } from "./pages/Login.tsx";
import { Signup } from "./pages/Signup.tsx";
import { ForgotPassword } from "./pages/ForgotPassword.tsx";
import { ResetPassword } from "./pages/ResetPassword.tsx";
import { VerifyEmail } from "./pages/VerifyEmail.tsx";
import { JoinProject } from "./pages/JoinProject.tsx";
import { ProtectedRoute } from "./components/routing/ProtectedRoute.tsx";

/** The playground pulls in Monaco and xterm — together the large majority of
 *  the bundle. Loading it lazily means the auth and dashboard routes no longer
 *  download an editor the visitor may never open. */
const ProjectPlayground = lazy(() =>
  import("./pages/ProjectPlayground.tsx").then((module) => ({
    default: module.ProjectPlayground,
  })),
);

/** Lazy because almost nobody is an operator. The queue is one page of table
 *  and two buttons, but it is a page every other visitor would download to
 *  never open. */
const ReportQueue = lazy(() =>
  import("./pages/ReportQueue.tsx").then((module) => ({
    default: module.ReportQueue,
  })),
);

/** Lazy for the same reason, and for one more: an embed is loaded by readers
 *  who did not ask for it, often several to a page. Nothing about the editor's
 *  own routes should be on their critical path, and nothing about theirs should
 *  be on the dashboard's. */
const EmbedPage = lazy(() =>
  import("./pages/EmbedPage.tsx").then((module) => ({
    default: module.EmbedPage,
  })),
);

const RouteFallback = () => (
  <Flex
    align="center"
    justify="center"
    style={{ minHeight: "100vh", backgroundColor: "var(--rc-surface)" }}
  >
    <Spin size="large" />
  </Flex>
);

export const Router = () => {
  const location = useLocation();

  return (
    // Keyed on the path so a crash on one route clears when you navigate away
    // rather than following you around the app.
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />

        {/* Deliberately outside ProtectedRoute: the page itself explains that
            signing in is needed, and carries the link through the detour. */}
        <Route path="/join" element={<JoinProject />} />

        {/* Outside it for a different reason: an embed's readers have no
            account and never will. Bouncing them to a login form inside an
            iframe on somebody's blog would be the whole feature failing. */}
        <Route
          path="/embed/:token"
          element={
            <Suspense fallback={<RouteFallback />}>
              <EmbedPage />
            </Suspense>
          }
        />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/project/:projectId"
          element={
            <ProtectedRoute>
              <Suspense fallback={<RouteFallback />}>
                <ProjectPlayground />
              </Suspense>
            </ProtectedRoute>
          }
        />

        {/* Behind auth but not behind an admin check on the client. The
            server checks the allowlist on every request, so a stranger who
            types this path gets a page saying it could not load the queue --
            and hiding the ROUTE would be a check that looks like security
            while enforcing nothing. */}
        <Route
          path="/admin/reports"
          element={
            <ProtectedRoute>
              <Suspense fallback={<RouteFallback />}>
                <ReportQueue />
              </Suspense>
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
};
