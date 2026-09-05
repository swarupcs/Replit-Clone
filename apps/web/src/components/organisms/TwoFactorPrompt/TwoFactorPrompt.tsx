import { useState } from "react";
import { Alert, Button, Input, Typography } from "antd";

/** The second step of a sign-in. plan.md §11.6.
 *
 *  Its own screen rather than a third box on the sign-in form, because it is a
 *  different question asked at a different moment: the password has already
 *  been accepted, and the server is holding a challenge that expires in five
 *  minutes. Showing it beside the password fields would invite people to fill
 *  both in at once, which they cannot -- the code they can see now will have
 *  changed by the time the password is checked.
 *
 *  One box for both kinds of code. A person who has lost their phone does not
 *  want to find the right tab first; the server can tell a six-digit code from
 *  a recovery code perfectly well, and does.
 */
interface TwoFactorPromptProps {
  onSubmit: (code: string) => Promise<void>;
  onCancel: () => void;
}

export function TwoFactorPrompt({ onSubmit, onCancel }: TwoFactorPromptProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    if (!code.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(code);
    } catch (submitError) {
      const response = (
        submitError as { response?: { data?: { message?: string } } }
      ).response;
      setError(response?.data?.message ?? "That code did not work.");
      // Cleared, because the code that just failed is either wrong or already
      // spent -- in both cases the next thing to type is a different one.
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rc-aurora rc-auth-shell">
      <div style={{ maxWidth: 380, margin: "0 auto", width: "100%" }}>
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>Enter your code</h1>
        <Typography.Paragraph
          style={{ color: "var(--rc-text-muted)", fontSize: 13.5 }}
        >
          Open your authenticator app and type the six digits it is showing. If
          you have lost the phone, one of your recovery codes goes here instead.
        </Typography.Paragraph>

        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 12 }}
          />
        )}

        <label htmlFor="rc-totp-code">Authentication code</label>
        <Input
          id="rc-totp-code"
          value={code}
          autoFocus
          // `one-time-code` is what lets a phone offer the code from the
          // notification, and `off` here would be a small daily annoyance.
          autoComplete="one-time-code"
          // Not `type="number"`, which strips the leading zero a TOTP code can
          // begin with and refuses the letters a recovery code contains.
          inputMode="text"
          placeholder="123456"
          style={{ marginTop: 4, marginBottom: 12 }}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          onPressEnter={() => void submit()}
        />

        <Button
          type="primary"
          block
          loading={submitting}
          disabled={!code.trim()}
          onClick={() => void submit()}
        >
          Sign in
        </Button>

        <Button type="link" block onClick={onCancel} style={{ marginTop: 8 }}>
          Use a different account
        </Button>
      </div>
    </div>
  );
}
