import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Вход",
};

export default function SignInPage() {
  return (
    <AuthShell title="С возвращением" subtitle="Продолжите сессию — войдите с рабочего email.">
      <Suspense fallback={<p className="text-center text-sm text-zinc-400">Загрузка…</p>}>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
