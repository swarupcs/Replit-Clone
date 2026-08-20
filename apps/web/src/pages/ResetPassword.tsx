import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Form, Input } from "antd";
import { resetPasswordApi } from "../apis/auth.ts";
import { AuthShell } from "../components/organisms/AuthForm/AuthShell.tsx";

/** Choosing a new password, from the link in the email. */
export const ResetPassword = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleFinish({ password }: { password: string }) {
    setError(null);
    setSubmitting(true);
    try {
      await resetPasswordApi(token, password);
      setDone(true);
    } catch (submitError) {
      setError(
        (submitError as { response?: { data?: { message?: string } } }).response
          ?.data?.message ?? "Could not change your password.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Reset your password" subtitle="Something is missing.">
        <Alert
          type="error"
          showIcon
          message="That link is incomplete"
          description="Open the link from your email again, or request a new one."
          style={{ marginBottom: 20 }}
        />
        <Link to="/forgot-password">Request a new link</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Then sign in with it.">
      {done ? (
        <>
          <Alert
            type="success"
            showIcon
            message="Password changed"
            // Said explicitly, because being signed out everywhere is
            // surprising unless you know it was deliberate.
            description="Every session was signed out, including any the person who prompted this may have had."
            style={{ marginBottom: 20 }}
          />
          <Button type="primary" block size="large" onClick={() => void navigate("/login")}>
            Sign in
          </Button>
        </>
      ) : (
        <>
          {error && (
            <Alert type="error" message={error} showIcon style={{ marginBottom: 20 }} />
          )}

          <Form
            layout="vertical"
            onFinish={(values: { password: string }) => void handleFinish(values)}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              label="New password"
              name="password"
              rules={[
                { required: true, message: "Password is required" },
                { min: 8, message: "At least 8 characters" },
              ]}
            >
              <Input.Password autoComplete="new-password" placeholder="At least 8 characters" />
            </Form.Item>

            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              Change password
            </Button>
          </Form>
        </>
      )}
    </AuthShell>
  );
};
