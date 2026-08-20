import { useNavigate } from "react-router-dom";
import { AuthForm } from "../components/organisms/AuthForm/AuthForm.tsx";
import { useAuth } from "../hooks/useAuth.ts";

export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  return (
    <AuthForm
      title="Welcome back"
      subtitle="Sign in to get back to your projects."
      submitLabel="Sign in"
      footer={{ prompt: "No account?", linkText: "Create one", to: "/signup" }}
      onSubmit={async (credentials) => {
        await login(credentials);
        void navigate("/", { replace: true });
      }}
    />
  );
};
