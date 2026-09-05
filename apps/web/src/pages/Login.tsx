import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthForm } from "../components/organisms/AuthForm/AuthForm.tsx";
import { TwoFactorPrompt } from "../components/organisms/TwoFactorPrompt/TwoFactorPrompt.tsx";
import { useAuth } from "../hooks/useAuth.ts";

export const Login = () => {
  const { login, completeTotp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  /** The challenge, when the account has a second factor.
   *
   *  Held in component state and nowhere else -- not in the session store, not
   *  in localStorage. A half-finished sign-in should leave nothing behind:
   *  closing the tab at this step is the same as never having started, and the
   *  challenge expires in five minutes regardless. plan.md §11.6.
   */
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  /** Where to go afterwards. Only same-site paths are honoured: an absolute
   *  URL here would make this an open redirect. */
  const next = params.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (mfaToken) {
    return (
      <TwoFactorPrompt
        onSubmit={async (code) => {
          await completeTotp(mfaToken, code);
          void navigate(destination, { replace: true });
        }}
        onCancel={() => {
          setMfaToken(null);
        }}
      />
    );
  }

  return (
    <AuthForm
      title="Welcome back"
      subtitle="Sign in to get back to your projects."
      submitLabel="Sign in"
      showForgotPassword
      footer={{ prompt: "No account?", linkText: "Create one", to: "/signup" }}
      onSubmit={async (credentials) => {
        const challenge = await login(credentials);
        // A challenge rather than a session: the password was right and the
        // account wants a code as well.
        if (challenge) {
          setMfaToken(challenge);
          return;
        }
        void navigate(destination, { replace: true });
      }}
    />
  );
};
