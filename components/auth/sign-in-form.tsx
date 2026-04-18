"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";

const LS_EMAIL = "jobaidemo_signin_email";
const LS_REMEMBER = "jobaidemo_signin_remember";

const emailSchema = z.string().email("Укажите корректный email");
const passwordSchema = z.string().min(8, "Не менее 8 символов").max(128);

const formSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

type FieldName = "email" | "password";

function mapSignInError(ctx: {
  error: { status?: number; message?: string; code?: string | number };
}): { message: string; needsVerification: boolean; focus?: "email" | "password" } {
  const status = ctx.error.status;
  const raw = (ctx.error.message ?? "").trim();
  const msg = raw.toLowerCase();
  const code = String(ctx.error.code ?? "").toLowerCase();

  if (status === 403) {
    return {
      message: "Подтвердите email перед входом.",
      needsVerification: true,
      focus: "email",
    };
  }
  if (status === 429) {
    return { message: "Слишком много попыток. Подождите немного и попробуйте снова.", needsVerification: false };
  }
  if (status === 401 || status === 400) {
    if (
      msg.includes("not found") ||
      msg.includes("no user") ||
      msg.includes("does not exist") ||
      code.includes("not_found") ||
      code.includes("user_not_found")
    ) {
      return { message: "Аккаунт с таким email не найден.", needsVerification: false, focus: "email" };
    }
    if (
      msg.includes("password") ||
      msg.includes("credential") ||
      msg.includes("invalid") ||
      code.includes("invalid") ||
      code.includes("credential")
    ) {
      return { message: "Неверный пароль.", needsVerification: false, focus: "password" };
    }
    return {
      message: "Email или пароль не совпадают с нашими данными. Попробуйте ещё раз.",
      needsVerification: false,
      focus: "email",
    };
  }
  if (raw) {
    return { message: raw, needsVerification: false };
  }
  return {
    message: "Не удалось войти. Проверьте данные и попробуйте снова.",
    needsVerification: false,
    focus: "email",
  };
}

function issueForPath(issues: z.ZodIssue[], path: string): string | undefined {
  return issues.find((i) => i.path.join(".") === path)?.message;
}

function postSignInPath(role: string | undefined): string {
  if (role === "employer") {
    return "/dashboard?welcome=employer";
  }
  return "/dashboard?welcome=candidate";
}

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const signedOutNotice = searchParams.get("signedOut") === "1";
  const formId = useId();
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const submitLockRef = useRef(false);

  const [form, setForm] = useState({
    email: "",
    password: "",
    rememberMe: false,
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [successHint, setSuccessHint] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<"idle" | "checking" | "signing_in" | "redirecting">("idle");
  const [showPassword, setShowPassword] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_REMEMBER) === "1") {
        const saved = localStorage.getItem(LS_EMAIL);
        if (saved) {
          setForm((f) => ({ ...f, email: saved, rememberMe: true }));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  const clearFieldError = useCallback((name: FieldName) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const validateEmail = useCallback(() => {
    const r = emailSchema.safeParse(form.email.trim());
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, email: r.error.issues[0]?.message ?? "Некорректный email" }));
      return false;
    }
    clearFieldError("email");
    return true;
  }, [form.email, clearFieldError]);

  const validatePassword = useCallback(() => {
    const r = passwordSchema.safeParse(form.password);
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, password: r.error.issues[0]?.message ?? "Некорректный пароль" }));
      return false;
    }
    clearFieldError("password");
    return true;
  }, [form.password, clearFieldError]);

  async function resendVerificationEmail() {
    const email = form.email.trim();
    if (!email) {
      setFormError("Введите email выше, затем нажмите «Отправить снова».");
      emailInputRef.current?.focus();
      return;
    }
    setResendBusy(true);
    setSuccessHint(null);
    try {
      const base = typeof window !== "undefined" ? `${window.location.origin}/api/auth` : "/api/auth";
      const res = await fetch(`${base}/send-verification-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, callbackURL: `${typeof window !== "undefined" ? window.location.origin : ""}/sign-in` }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = "Не удалось отправить письмо. Попробуйте позже.";
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
      setFormError(null);
      setSuccessHint("Если аккаунт существует, мы отправили новую ссылку для подтверждения.");
    } catch {
      setFormError("Ошибка сети. Проверьте подключение и попробуйте снова.");
    } finally {
      setResendBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitLockRef.current || loading) {
      return;
    }
    setFormError(null);
    setSuccessHint(null);
    setNeedsVerification(false);
    setTouched({ email: true, password: true });

    const parsed = formSchema.safeParse({
      email: form.email.trim(),
      password: form.password,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      setFieldErrors({
        email: issueForPath(issues, "email"),
        password: issueForPath(issues, "password"),
      });
      setFormError(issues[0]?.message ?? "Исправьте ошибки в полях ниже.");
      return;
    }

    submitLockRef.current = true;
    setLoading(true);
    setLoadingStage("checking");
    try {
      await new Promise((r) => setTimeout(r, 0));
      setLoadingStage("signing_in");

      await authClient.signIn.email(
        {
          email: parsed.data.email,
          password: parsed.data.password,
        },
        {
          onSuccess: async () => {
            try {
              try {
                if (form.rememberMe) {
                  localStorage.setItem(LS_REMEMBER, "1");
                  localStorage.setItem(LS_EMAIL, parsed.data.email);
                } else {
                  localStorage.removeItem(LS_REMEMBER);
                  localStorage.removeItem(LS_EMAIL);
                }
              } catch {
                /* ignore */
              }

              setLoadingStage("redirecting");
              router.refresh();
              await new Promise((r) => setTimeout(r, 50));

              const sessionRes = await authClient.getSession();
              const user = sessionRes.data?.user as { role?: string } | undefined;
              const role = user?.role;

              router.push(postSignInPath(role));
              router.refresh();
            } catch {
              router.push("/dashboard?welcome=candidate");
              router.refresh();
            }
          },
          onError: (ctx) => {
            const mapped = mapSignInError(ctx);
            setFormError(mapped.message);
            setNeedsVerification(mapped.needsVerification);
            queueMicrotask(() => {
              if (mapped.focus === "password") {
                passwordInputRef.current?.focus();
              } else if (mapped.focus === "email") {
                emailInputRef.current?.focus();
              }
            });
          },
        },
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Что-то пошло не так.");
    } finally {
      submitLockRef.current = false;
      setLoading(false);
      setLoadingStage("idle");
    }
  }

  const loadingLabel =
    loadingStage === "redirecting"
      ? "Переходим в рабочую область…"
      : loadingStage === "signing_in"
        ? "Входим…"
        : loadingStage === "checking"
          ? "Проверяем данные…"
          : "Войти";

  return (
    <div className="space-y-2">
      <div className="sr-only" aria-live="polite">
        {loading ? loadingLabel : ""}
      </div>

      <form id={formId} onSubmit={onSubmit} className="space-y-5" noValidate>
        {signedOutNotice ? (
          <div
            role="status"
            className="rounded-lg border border-emerald-500/25 bg-emerald-950/25 px-3 py-2 text-sm text-emerald-100"
          >
            Вы вышли из аккаунта. Войдите снова, когда будете готовы продолжить.
          </div>
        ) : null}
        {formError ? (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-200"
          >
            {formError}
            {needsVerification ? (
              <div className="mt-3 border-t border-red-500/20 pt-3">
                <button
                  type="button"
                  className="text-sm font-medium text-white underline-offset-4 hover:underline disabled:opacity-50"
                  onClick={() => void resendVerificationEmail()}
                  disabled={resendBusy || loading}
                >
                  {resendBusy ? "Отправка…" : "Отправить письмо подтверждения снова"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {successHint ? (
          <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
            {successHint}
          </div>
        ) : null}

        <div className="space-y-2">
          <label htmlFor="signin-email" className="text-sm font-medium text-zinc-300">
            Email
          </label>
          <input
            ref={emailInputRef}
            id="signin-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "signin-email-error" : undefined}
            value={form.email}
            onChange={(e) => {
              setForm((f) => ({ ...f, email: e.target.value }));
              if (touched.email) {
                validateEmail();
              } else {
                clearFieldError("email");
              }
            }}
            onBlur={() => {
              setTouched((t) => ({ ...t, email: true }));
              validateEmail();
            }}
            className={`w-full rounded-lg border bg-black/40 px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
              fieldErrors.email ? "border-red-500/50 focus:border-red-400/50" : "border-white/10 focus:border-white/20"
            }`}
            placeholder="you@company.com"
            disabled={loading}
          />
          {fieldErrors.email ? (
            <p id="signin-email-error" className="text-xs text-red-300" role="status">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="signin-password" className="text-sm font-medium text-zinc-300">
              Пароль
            </label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
            >
              Забыли пароль?
            </Link>
          </div>
          <div className="relative">
            <input
              ref={passwordInputRef}
              id="signin-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? "signin-password-error" : undefined}
              value={form.password}
              onChange={(e) => {
                setForm((f) => ({ ...f, password: e.target.value }));
                if (touched.password) {
                  validatePassword();
                } else {
                  clearFieldError("password");
                }
              }}
              onBlur={() => {
                setTouched((t) => ({ ...t, password: true }));
                validatePassword();
              }}
              className={`w-full rounded-lg border bg-black/40 py-2.5 pl-4 pr-12 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
                fieldErrors.password ? "border-red-500/50 focus:border-red-400/50" : "border-white/10 focus:border-white/20"
              }`}
              placeholder="••••••••"
              disabled={loading}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-400 hover:text-zinc-200"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
          {fieldErrors.password ? (
            <p id="signin-password-error" className="text-xs text-red-300" role="status">
              {fieldErrors.password}
            </p>
          ) : null}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            name="rememberMe"
            checked={form.rememberMe}
            onChange={(e) => setForm((f) => ({ ...f, rememberMe: e.target.checked }))}
            disabled={loading}
            className="h-4 w-4 rounded border-white/20 bg-black/40 text-white focus:ring-white/20"
          />
          Запомнить на этом устройстве
        </label>

        <button
          type="submit"
          form={formId}
          disabled={loading}
          aria-busy={loading}
          className="inline-flex w-full items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? loadingLabel : "Войти"}
        </button>
      </form>

      <p className="text-center text-sm text-zinc-500">
        Нет аккаунта?{" "}
        <Link href="/sign-up" className="font-medium text-white underline-offset-4 hover:text-zinc-200 hover:underline">
          Создать
        </Link>
      </p>
    </div>
  );
}
