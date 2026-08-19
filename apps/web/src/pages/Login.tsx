import { useNavigate } from "react-router-dom";
import { AuthForm } from "../components/organisms/AuthForm/AuthForm.tsx";
import { useAuth } from "../hooks/useAuth.ts";

export const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  return (
    <AuthForm
      title="Sign in"
      submitLabel="Sign in"
      footer={{ prompt: "No account?", linkText: "Create one", to: "/signup" }}
      onSubmit={async (credentials) => {
        await login(credentials);
        navigate("/", { replace: true });
      }}
    />
  );
};
