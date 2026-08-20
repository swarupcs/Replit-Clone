import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthForm } from "../components/organisms/AuthForm/AuthForm.tsx";
import { useAuth } from "../hooks/useAuth.ts";

export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  /** Where to go afterwards. Only same-site paths are honoured: an absolute
   *  URL here would make this an open redirect. */
  const next = params.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <AuthForm
      title="Welcome back"
      subtitle="Sign in to get back to your projects."
      submitLabel="Sign in"
      showForgotPassword
      footer={{ prompt: "No account?", linkText: "Create one", to: "/signup" }}
      onSubmit={async (credentials) => {
        await login(credentials);
        void navigate(destination, { replace: true });
      }}
    />
  );
};
