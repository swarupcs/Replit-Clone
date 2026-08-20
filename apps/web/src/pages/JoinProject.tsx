import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Spin, Typography } from "antd";
import { previewShareLinkApi, redeemShareLinkApi } from "../apis/projects.ts";
import { AuthShell } from "../components/organisms/AuthForm/AuthShell.tsx";
import { useAuth } from "../hooks/useAuth.ts";

/** Opening a share link.
 *
 *  Shows what the link points at before joining, so someone can tell whether it
 *  is the one they were expecting. Signing in is required — a link grants
 *  access to an account, so there has to be an account to grant it to.
 */
export const JoinProject = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { isAuthenticated, isReady } = useAuth();

  const token = params.get("token") ?? "";

  const [project, setProject] = useState<{ name: string; template: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    void previewShareLinkApi(token)
      .then((result) => !cancelled && setProject(result))
      .catch(() => !cancelled && setProject(null))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      const joined = await redeemShareLinkApi(token);
      void navigate(`/project/${joined.id}`, { replace: true });
    } catch (joinError) {
      setError(
        (joinError as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not open that project.",
      );
      setJoining(false);
    }
  }

  if (loading || !isReady) {
    return (
      <AuthShell title="Shared project" subtitle="Checking the link…">
        <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
          <Spin />
        </div>
      </AuthShell>
    );
  }

  if (!project) {
    return (
      <AuthShell title="Shared project" subtitle="This link did not work.">
        <Alert
          type="error"
          showIcon
          message="That link is no longer valid"
          description="It may have been replaced or revoked. Ask whoever shared it for a new one."
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={project.name} subtitle="Someone shared this project with you.">
      <Typography.Paragraph style={{ color: "var(--rc-text-subtle)", fontSize: 13.5 }}>
        You will be able to read its files and watch the preview. Editing,
        running it, and opening a terminal stay with the owner unless they give
        you more access.
      </Typography.Paragraph>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      {isAuthenticated ? (
        <Button type="primary" block size="large" loading={joining} onClick={() => void join()}>
          Open project
        </Button>
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            message="Sign in to continue"
            description="A shared project is added to your account, so you need one first."
            style={{ marginBottom: 16 }}
          />
          {/* The link is carried through, so signing in lands back here rather
              than on the dashboard with the invitation lost. */}
          <Link to={`/login?next=${encodeURIComponent(`/join?token=${token}`)}`}>
            <Button type="primary" block size="large">
              Sign in
            </Button>
          </Link>
        </>
      )}
    </AuthShell>
  );
};
