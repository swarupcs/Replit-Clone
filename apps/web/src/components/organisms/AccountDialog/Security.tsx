import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Tag, Typography } from "antd";
import type { TwoFactorStatus } from "@replit-clone/shared";
import {
  beginTwoFactorApi,
  confirmTwoFactorApi,
  disableTwoFactorApi,
  regenerateRecoveryCodesApi,
  twoFactorStatusApi,
} from "../../../apis/auth.ts";

/** Two-factor authentication. plan.md §11.6.
 *
 *  §10.3 kept sign-in even at n=1, because a server that issued a session to
 *  anybody who asked would be an unauthenticated server on whatever network it
 *  can be reached from. This is the rest of that thought: once the network is
 *  the internet, what is behind the password is not a document, it is a shell
 *  on the machine with the source tree mounted.
 *
 *  Offered, not enforced. On a laptop the network is the protection and a
 *  phone would be in the way, and the platform is in no position to decide
 *  which of those somebody is running.
 */

function messageOf(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { message?: string } } })
    .response;
  return response?.data?.message ?? fallback;
}

/** Shown once, and never again by anything.
 *
 *  Rendered as selectable text rather than behind a download, because the
 *  Artifact-style download a browser would offer is exactly what an editor
 *  running in a sandboxed frame cannot reliably deliver -- and because the
 *  thing most people actually do is paste them into a password manager.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      message="Save these recovery codes now"
      description={
        <>
          <Typography.Paragraph style={{ fontSize: 12.5 }}>
            Each one signs you in once if you lose your phone. They are shown
            here and nowhere else — the server keeps only their hashes.
          </Typography.Paragraph>
          <pre
            aria-label="Recovery codes"
            style={{
              margin: 0,
              padding: 10,
              borderRadius: 6,
              background: "var(--rc-surface-2, rgba(0,0,0,0.05))",
              fontSize: 13,
              lineHeight: 1.7,
              userSelect: "all",
            }}
          >
            {codes.join("\n")}
          </pre>
        </>
      }
    />
  );
}

export function Security() {
  const queryClient = useQueryClient();

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Held only until the panel is closed. Deliberately not cached in the query
   *  client: a set of recovery codes is not a thing to keep in memory for the
   *  rest of the session. */
  const [codes, setCodes] = useState<string[] | null>(null);

  const { data: status, isLoading } = useQuery<TwoFactorStatus>({
    queryKey: ["twoFactor"],
    queryFn: twoFactorStatusApi,
    retry: false,
  });

  const [enrolling, setEnrolling] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);

  function refresh(next: TwoFactorStatus): void {
    queryClient.setQueryData(["twoFactor"], next);
  }

  const begin = useMutation({
    mutationFn: beginTwoFactorApi,
    onSuccess: (offer) => {
      setError(null);
      setCodes(null);
      setEnrolling(offer);
    },
    onError: (failure) => {
      setError(messageOf(failure, "Could not start setting that up."));
    },
  });

  const confirm = useMutation({
    mutationFn: () => confirmTwoFactorApi(code),
    onSuccess: (result) => {
      setError(null);
      setEnrolling(null);
      setCode("");
      setCodes(result.recoveryCodes);
      refresh(result.status);
    },
    onError: (failure) => {
      setError(messageOf(failure, "That code did not match."));
    },
  });

  const disable = useMutation({
    mutationFn: () => disableTwoFactorApi(password),
    onSuccess: (next) => {
      setError(null);
      setPassword("");
      setCodes(null);
      refresh(next);
    },
    onError: (failure) => {
      setError(messageOf(failure, "Could not turn that off."));
    },
  });

  const regenerate = useMutation({
    mutationFn: () => regenerateRecoveryCodesApi(password),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setCodes(result.recoveryCodes);
      refresh(result.status);
    },
    onError: (failure) => {
      setError(messageOf(failure, "Could not make new codes."));
    },
  });

  if (isLoading || !status) {
    return (
      <span className="rc-skeleton" style={{ height: 80, display: "block" }} />
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <Typography.Text strong>Two-factor authentication</Typography.Text>
        {status.enabled ? (
          <Tag color="green">On</Tag>
        ) : status.pending ? (
          <Tag color="gold">Half set up</Tag>
        ) : (
          <Tag>Off</Tag>
        )}
      </div>

      <Typography.Paragraph
        style={{ color: "var(--rc-text-subtle)", fontSize: 12.5 }}
      >
        A code from your phone as well as your password. Worth turning on if
        this server can be reached from outside your own network — what is
        behind the password here is a terminal on the machine, not just your
        files.
      </Typography.Paragraph>

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          message={error}
          style={{ marginBottom: 12 }}
          onClose={() => {
            setError(null);
          }}
        />
      )}

      {/* Said plainly, because an account with none left is one lost phone
          away from being unreachable, and nothing else would ever mention it. */}
      {status.enabled && status.recoveryCodesLeft === 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="No recovery codes left"
          description="If you lose your phone now, you will not be able to sign in. Make a new set below."
        />
      )}

      {codes && <RecoveryCodes codes={codes} />}

      {/* Worth saying where the decision is made rather than in a document
          nobody reads afterwards. On a single-user deployment the documented
          way back into a locked-out account is SINGLE_USER_PASSWORD and a
          restart -- which resets the password and does nothing about this.
          Once it is on, the recovery codes are the only way back. */}
      {!status.enabled && !enrolling && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Keep the recovery codes somewhere real"
          description="Once this is on, a password reset alone will not get you back in — including the environment-variable reset a single-user deployment uses."
        />
      )}

      {enrolling ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph style={{ fontSize: 12.5, marginBottom: 6 }}>
            Add this to your authenticator app, then type the code it shows to
            prove it worked. Nothing is switched on until that code matches —
            which is what stops a mistyped setup locking you out.
          </Typography.Paragraph>

          <label htmlFor="rc-2fa-secret">Setup key</label>
          <Input.TextArea
            id="rc-2fa-secret"
            readOnly
            autoSize
            value={enrolling.secret}
            style={{ marginTop: 4, marginBottom: 10 }}
          />

          <label htmlFor="rc-2fa-code">Code from the app</label>
          <Input
            id="rc-2fa-code"
            value={code}
            autoComplete="one-time-code"
            inputMode="numeric"
            placeholder="123456"
            style={{ marginTop: 4, marginBottom: 10 }}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />

          <div style={{ display: "flex", gap: 10 }}>
            <Button
              type="primary"
              loading={confirm.isPending}
              disabled={!code.trim()}
              onClick={() => {
                confirm.mutate();
              }}
            >
              Turn it on
            </Button>
            <Button
              onClick={() => {
                setEnrolling(null);
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : status.enabled ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph style={{ fontSize: 12.5 }}>
            {status.recoveryCodesLeft} recovery{" "}
            {status.recoveryCodesLeft === 1 ? "code" : "codes"} left.
          </Typography.Paragraph>

          {/* The password again, on both of the actions that make the account
              weaker. A session is not consent to remove the protection on the
              account it belongs to. */}
          <label htmlFor="rc-2fa-password">Confirm your password</label>
          <Input.Password
            id="rc-2fa-password"
            value={password}
            autoComplete="current-password"
            style={{ marginTop: 4, marginBottom: 10 }}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />

          <div style={{ display: "flex", gap: 10 }}>
            <Button
              loading={regenerate.isPending}
              disabled={!password}
              onClick={() => {
                regenerate.mutate();
              }}
            >
              New recovery codes
            </Button>
            <Button
              danger
              loading={disable.isPending}
              disabled={!password}
              onClick={() => {
                disable.mutate();
              }}
            >
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="primary"
          loading={begin.isPending}
          onClick={() => {
            begin.mutate();
          }}
        >
          {status.pending ? "Start again" : "Set up two-factor"}
        </Button>
      )}
    </div>
  );
}
