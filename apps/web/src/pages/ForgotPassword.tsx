import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Form, Input, Typography } from "antd";
import { requestPasswordResetApi } from "../apis/auth.ts";
import { AuthShell } from "../components/organisms/AuthForm/AuthShell.tsx";

/** Asking for a reset link.
 *
 *  Always reports the same thing whether or not the address has an account:
 *  telling a stranger which emails are registered here is the first step of
 *  attacking one of them.
 */
export const ForgotPassword = () => {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState<{ delivered: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish({ email }: { email: string }) {
    setError(null);
    setSubmitting(true);
    try {
      setSent(await requestPasswordResetApi(email));
    } catch {
      setError("Could not send a reset link. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll send a link to set a new one."
    >
      {sent ? (
        <>
          <Alert
            type="success"
            showIcon
            message="Check your email"
            description={
              sent.delivered
                ? "If that address has an account, a reset link is on its way. It expires in an hour."
                : // Development has no mailer, and a silent non-delivery looks
                  // exactly like a deleted account.
                  "This server has no mail configured, so the link was written to the server log instead."
            }
            style={{ marginBottom: 20 }}
          />
          <Link to="/login">Back to sign in</Link>
        </>
      ) : (
        <>
          {error && (
            <Alert type="error" message={error} showIcon style={{ marginBottom: 20 }} />
          )}

          <Form
            layout="vertical"
            onFinish={(values: { email: string }) => void handleFinish(values)}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              label="Email"
              name="email"
              rules={[{ required: true, message: "Email is required" }]}
            >
              <Input type="email" autoComplete="email" placeholder="you@example.com" />
            </Form.Item>

            <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
              Send reset link
            </Button>
          </Form>

          <Typography.Paragraph
            style={{
              marginTop: 20,
              marginBottom: 0,
              textAlign: "center",
              color: "var(--rc-text-subtle)",
              fontSize: 13,
            }}
          >
            Remembered it? <Link to="/login">Sign in</Link>
          </Typography.Paragraph>
        </>
      )}
    </AuthShell>
  );
};
