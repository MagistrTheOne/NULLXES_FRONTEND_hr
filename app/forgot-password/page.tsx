import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Сброс пароля",
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Сброс пароля"
      subtitle="Мы отправим ссылку на email, чтобы задать новый пароль. После этого вы вернётесь сюда для входа."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
