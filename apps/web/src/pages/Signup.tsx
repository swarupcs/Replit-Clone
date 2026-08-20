import { useNavigate } from "react-router-dom";
import { AuthForm } from "../components/organisms/AuthForm/AuthForm.tsx";
import { useAuth } from "../hooks/useAuth.ts";

export const Signup = () => {
  const { signup } = useAuth();
  const navigate = useNavigate();

  return (
    <AuthForm
      title="Create your account"
      subtitle="Free to start. No credit card, no setup."
      submitLabel="Create account"
      footer={{ prompt: "Already registered?", linkText: "Sign in", to: "/login" }}
      onSubmit={async (credentials) => {
        await signup(credentials);
        navigate("/", { replace: true });
      }}
    />
  );
};
