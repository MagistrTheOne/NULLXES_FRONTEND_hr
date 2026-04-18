import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = {
  title: "Регистрация",
};

export default function SignUpPage() {
  return (
    <AuthShell title="Создать аккаунт" subtitle="Заполните профиль, чтобы продолжить.">
      <SignUpForm />
    </AuthShell>
  );
}
