import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { Link } from "react-router-dom";
import { credentialsSchema } from "@replit-clone/shared";
import type { Credentials } from "@replit-clone/shared";

interface AuthFormProps {
  title: string;
  submitLabel: string;
  footer: { prompt: string; linkText: string; to: string };
  onSubmit: (credentials: Credentials) => Promise<void>;
}

interface ApiErrorBody {
  message?: string;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { data?: ApiErrorBody } }).response;
    if (response?.data?.message) return response.data.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

export const AuthForm = ({
  title,
  submitLabel,
  footer,
  onSubmit,
}: AuthFormProps) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish(values: Credentials) {
    setError(null);
    setSubmitting(true);
    try {
      // Validate with the same schema the server uses, so the form never
      // submits something the API will reject for an unshown reason.
      await onSubmit(credentialsSchema.parse(values));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--rc-surface)",
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>

        {error && (
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Form layout="vertical" onFinish={handleFinish} requiredMark={false}>
          <Form.Item
            label="Email"
            name="email"
            rules={[{ required: true, message: "Email is required" }]}
          >
            <Input type="email" autoComplete="email" placeholder="you@example.com" />
          </Form.Item>

          <Form.Item
            label="Password"
            name="password"
            rules={[{ required: true, message: "Password is required" }]}
          >
            <Input.Password
              autoComplete="current-password"
              placeholder="At least 8 characters"
            />
          </Form.Item>

          <Button type="primary" htmlType="submit" block loading={submitting}>
            {submitLabel}
          </Button>
        </Form>

        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          {footer.prompt} <Link to={footer.to}>{footer.linkText}</Link>
        </Typography.Paragraph>
      </Card>
    </div>
  );
};
