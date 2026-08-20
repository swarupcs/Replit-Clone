import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Spin } from "antd";
import { verifyEmailApi } from "../apis/auth.ts";
import { AuthShell } from "../components/organisms/AuthForm/AuthShell.tsx";

/** Confirming an address, from the link in the email. */
export const VerifyEmail = () => {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [state, setState] = useState<"working" | "done" | "failed">("working");

  useEffect(() => {
    if (!token) {
      setState("failed");
      return;
    }

    let cancelled = false;

    void verifyEmailApi(token)
      .then(() => !cancelled && setState("done"))
      .catch(() => !cancelled && setState("failed"));

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthShell title="Confirm your email" subtitle="One less thing to worry about.">
      {state === "working" ? (
        <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : state === "done" ? (
        <Alert
          type="success"
          showIcon
          message="Address confirmed"
          description={<Link to="/">Go to your projects</Link>}
        />
      ) : (
        <Alert
          type="error"
          showIcon
          message="That link is no longer valid"
          description="Links expire after a day and work once. Request a new one from your account."
        />
      )}
    </AuthShell>
  );
};
