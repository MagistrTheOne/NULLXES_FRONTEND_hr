"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";

const emailSchema = z.string().email("Укажите корректный email");

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Некорректный email");
      return;
    }
    setFieldError(null);
    setLoading(true);
    try {
      const redirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/sign-in` : "/sign-in";
      const client = authClient as unknown as {
        requestPasswordReset?: (opts: { email: string; redirectTo: string }) => Promise<{ error?: { message?: string } }>;
      };
      if (typeof client.requestPasswordReset === "function") {
        const res = await client.requestPasswordReset({ email: parsed.data, redirectTo });
        if (res?.error?.message) {
          setFormError(res.error.message);
          return;
        }
      } else {
        const r = await fetch("/api/auth/request-password-reset", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: parsed.data, redirectTo }),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          let message = "Не удалось начать сброс. Попробуйте позже.";
          try {
            const j = JSON.parse(text) as { message?: string };
            if (j.message) {
              message = j.message;
            }
          } catch {
            if (text) {
              message = text;
            }
          }
          setFormError(message);
          return;
        }
      }
      setDone(true);
    } catch {
      setFormError("Что-то пошло не так. Попробуйте снова.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-zinc-300" role="status">
          Если аккаунт существует, мы отправили инструкции по сбросу. Проверьте почту и папку «Спам».
        </p>
        <Link
          href="/sign-in"
          className="inline-flex w-full items-center justify-center rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/5"
        >
          Вернуться ко входу
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {formError ? (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {formError}
        </div>
      ) : null}
      <div className="space-y-2">
        <label htmlFor="forgot-email" className="text-sm font-medium text-zinc-300">
          Email
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={Boolean(fieldError)}
          aria-describedby={fieldError ? "forgot-email-error" : undefined}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldError(null);
          }}
          onBlur={() => {
            const r = emailSchema.safeParse(email.trim());
            setFieldError(r.success ? null : r.error.issues[0]?.message ?? null);
          }}
          className={`w-full rounded-lg border bg-black/40 px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
            fieldError ? "border-red-500/50" : "border-white/10 focus:border-white/20"
          }`}
          placeholder="you@company.com"
          disabled={loading}
        />
        {fieldError ? (
          <p id="forgot-email-error" className="text-xs text-red-300" role="status">
            {fieldError}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={loading}
        className="inline-flex w-full items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Отправка…" : "Отправить ссылку"}
      </button>
      <p className="text-center text-sm text-zinc-500">
        <Link href="/sign-in" className="font-medium text-white underline-offset-4 hover:text-zinc-200 hover:underline">
          Вернуться ко входу
        </Link>
      </p>
    </form>
  );
}
