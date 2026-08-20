import { useState } from "react";
import { Alert, Button, Form, Input, Typography } from "antd";
import { Link } from "react-router-dom";
import { credentialsSchema } from "@replit-clone/shared";
import type { Credentials } from "@replit-clone/shared";

interface AuthFormProps {
  title: string;
  subtitle: string;
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

/** Three short lines of value proposition, shown beside the form on wide
 *  screens. Kept static -- this is chrome, not content. */
const HIGHLIGHTS = [
  {
    title: "Real containers",
    body: "Every project runs isolated, with its own shell and resource budget.",
  },
  {
    title: "Instant preview",
    body: "Your dev server is proxied straight back into the editor, HMR included.",
  },
  {
    title: "Batteries included",
    body: "React, Next.js, Express, Python — in JavaScript or TypeScript.",
  },
];

export const AuthForm = ({
  title,
  subtitle,
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
      className="rc-aurora"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          display: "grid",
          // Collapses to a single column below ~900px, dropping the pitch panel.
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 48,
          alignItems: "center",
          width: "100%",
          maxWidth: 940,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 28,
            }}
          >
            <span className="rc-logo">&lt;/&gt;</span>
            <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: -0.2 }}>
              Playground
            </span>
          </div>

          <h1
            style={{
              fontSize: 40,
              lineHeight: 1.12,
              fontWeight: 800,
              letterSpacing: -1.2,
              marginBottom: 14,
            }}
          >
            Code anything,
            <br />
            <span className="rc-gradient-text">right in the browser.</span>
          </h1>

          <p
            style={{
              color: "var(--rc-text-muted)",
              fontSize: 15,
              lineHeight: 1.6,
              maxWidth: 420,
              marginBottom: 32,
            }}
          >
            Spin up a full dev environment in seconds — editor, terminal, and a
            live preview, all backed by a real container.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {HIGHLIGHTS.map((item) => (
              <div key={item.title} style={{ display: "flex", gap: 12 }}>
                <span
                  aria-hidden
                  style={{
                    marginTop: 7,
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--rc-gradient)",
                    flex: "none",
                  }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                    {item.title}
                  </div>
                  <div
                    style={{
                      color: "var(--rc-text-subtle)",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    {item.body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rc-panel" style={{ padding: 32, minWidth: 0 }}>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            {title}
          </Typography.Title>
          <Typography.Paragraph
            style={{ color: "var(--rc-text-subtle)", marginBottom: 24 }}
          >
            {subtitle}
          </Typography.Paragraph>

          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              style={{ marginBottom: 20 }}
            />
          )}

          <Form
            layout="vertical"
            onFinish={(values: Credentials) => void handleFinish(values)}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              label="Email"
              name="email"
              rules={[{ required: true, message: "Email is required" }]}
            >
              <Input
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
            </Form.Item>

            <Form.Item
              label="Password"
              name="password"
              rules={[{ required: true, message: "Password is required" }]}
              style={{ marginBottom: 24 }}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="At least 8 characters"
              />
            </Form.Item>

            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
            >
              {submitLabel}
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
            {footer.prompt} <Link to={footer.to}>{footer.linkText}</Link>
          </Typography.Paragraph>
        </div>
      </div>
    </div>
  );
};
