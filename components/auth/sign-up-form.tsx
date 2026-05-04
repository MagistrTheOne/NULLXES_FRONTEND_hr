"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { createEmployerCompany } from "@/app/actions/employer-onboarding";
import { authClient } from "@/lib/auth-client";

const STORAGE_LAST_ROLE = "jobaidemo_signup_last_role";
const STEP = { credentials: 1, role: 2, profile: 3 } as const;
type Step = (typeof STEP)[keyof typeof STEP];

const passwordFieldSchema = z
  .string()
  .min(8, "Не менее 8 символов")
  .max(128, "Не более 128 символов")
  .regex(/[A-Za-zА-Яа-яЁё]/, "Добавьте хотя бы одну букву")
  .regex(/[0-9]/, "Добавьте хотя бы одну цифру");

const emailSchema = z.string().email("Укажите корректный email");

const formSchema = z
  .object({
    name: z.string().min(1, "Укажите имя").max(120),
    email: emailSchema,
    password: passwordFieldSchema,
    role: z.enum(["candidate", "employer"]),
    companyName: z.string().max(256).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "employer" && (!data.companyName || data.companyName.trim().length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Для работодателя нужно указать название компании",
        path: ["companyName"],
      });
    }
  });

type FieldName = "email" | "password" | "name" | "companyName" | "role";

function issueForPath(issues: z.ZodIssue[], path: string): string | undefined {
  return issues.find((i) => i.path.join(".") === path)?.message;
}

function describeSignUpError(ctx: {
  error: { message?: string; status?: number; code?: string };
}): string {
  const msg = ctx.error.message?.trim();
  if (msg) {
    return msg;
  }
  if (ctx.error.status === 409) {
    return "Аккаунт с таким email уже может существовать. Попробуйте войти.";
  }
  if (ctx.error.status === 422) {
    return "Проверьте данные и попробуйте снова.";
  }
  return "Не удалось создать аккаунт. Попробуйте ещё раз.";
}

function getPasswordChecks(password: string) {
  return {
    length: password.length >= 8,
    letter: /[A-Za-zА-Яа-яЁё]/.test(password),
    number: /[0-9]/.test(password),
  };
}

function postSignupPath(
  role: "candidate" | "employer",
  employerOnboardingFailed: boolean,
  onboardingError?: string | null
): string {
  if (employerOnboardingFailed) {
    const q = new URLSearchParams({ employerOnboarding: "pending" });
    if (onboardingError) {
      q.set("onboardingError", onboardingError);
    }
    return `/dashboard?${q.toString()}`;
  }
  if (role === "candidate") {
    return "/dashboard?welcome=candidate";
  }
  return "/dashboard?welcome=employer";
}

export function SignUpForm() {
  const router = useRouter();
  const formId = useId();
  const submitLockRef = useRef(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(STEP.credentials);
  const [form, setForm] = useState({
    email: "",
    password: "",
    name: "",
    role: "candidate" as "candidate" | "employer",
    companyName: "",
  });

  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<"idle" | "creating" | "workspace">("idle");
  const [showPassword, setShowPassword] = useState(false);

  const passwordChecks = useMemo(() => getPasswordChecks(form.password), [form.password]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_LAST_ROLE);
      if (saved === "candidate" || saved === "employer") {
        setForm((f) => ({ ...f, role: saved }));
      }
    } catch {
   
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LAST_ROLE, form.role);
    } catch {

    }
  }, [form.role]);

  useEffect(() => {
    const t = requestAnimationFrame(() => {
      if (step === STEP.credentials) {
        emailInputRef.current?.focus();
      } else if (step === STEP.profile) {
        nameInputRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(t);
  }, [step]);

  const clearFieldError = useCallback((name: FieldName) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const validateEmailField = useCallback(() => {
    const r = emailSchema.safeParse(form.email);
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, email: r.error.issues[0]?.message ?? "Некорректный email" }));
      return false;
    }
    clearFieldError("email");
    return true;
  }, [form.email, clearFieldError]);

  const validatePasswordField = useCallback(() => {
    const r = passwordFieldSchema.safeParse(form.password);
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, password: r.error.issues[0]?.message ?? "Некорректный пароль" }));
      return false;
    }
    clearFieldError("password");
    return true;
  }, [form.password, clearFieldError]);

  const validateNameField = useCallback(() => {
    const r = z.string().min(1, "Укажите имя").max(120).safeParse(form.name);
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, name: r.error.issues[0]?.message ?? "Некорректное имя" }));
      return false;
    }
    clearFieldError("name");
    return true;
  }, [form.name, clearFieldError]);

  const validateCompanyField = useCallback(() => {
    if (form.role !== "employer") {
      clearFieldError("companyName");
      return true;
    }
    const r = z.string().min(1, "Укажите название компании").max(256).safeParse(form.companyName.trim());
    if (!r.success) {
      setFieldErrors((prev) => ({ ...prev, companyName: r.error.issues[0]?.message ?? "Некорректное название" }));
      return false;
    }
    clearFieldError("companyName");
    return true;
  }, [form.role, form.companyName, clearFieldError]);

  function goNextFromCredentials(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setTouched((t) => ({ ...t, email: true, password: true }));
    const okE = validateEmailField();
    const okP = validatePasswordField();
    if (okE && okP) {
      setStep(STEP.role);
    }
  }

  function goNextFromRole(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setStep(STEP.profile);
  }

  function goBack() {
    setFormError(null);
    if (step === STEP.role) {
      setStep(STEP.credentials);
    } else if (step === STEP.profile) {
      setStep(STEP.role);
    }
  }

  async function onFinalSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitLockRef.current || loading) {
      return;
    }
    setFormError(null);
    setTouched({ email: true, password: true, name: true, companyName: form.role === "employer", role: true });

    const parsed = formSchema.safeParse({
      name: form.name.trim(),
      email: form.email.trim(),
      password: form.password,
      role: form.role,
      companyName: form.role === "employer" ? form.companyName.trim() : undefined,
    });

    if (!parsed.success) {
      const issues = parsed.error.issues;
      setFieldErrors({
        email: issueForPath(issues, "email"),
        password: issueForPath(issues, "password"),
        name: issueForPath(issues, "name"),
        companyName: issueForPath(issues, "companyName"),
      });
      const first = issues[0]?.message ?? "Исправьте ошибки в полях ниже.";
      setFormError(first);
      return;
    }

    submitLockRef.current = true;
    setLoading(true);
    setLoadingStage("creating");

    try {
      await authClient.signUp.email(
        {
          name: parsed.data.name,
          email: parsed.data.email,
          password: parsed.data.password,
          role: parsed.data.role,
          callbackURL: "/dashboard",
        },
        {
          async onSuccess() {
            try {
              router.refresh();
              await new Promise((r) => setTimeout(r, 50));

              if (parsed.data.role === "employer") {
                setLoadingStage("workspace");
                const onboard = await createEmployerCompany(parsed.data.companyName!.trim());
                if (!onboard.ok) {
                  const errMsg = onboard.error ?? "Не удалось сохранить компанию";
                  router.push(postSignupPath("employer", true, errMsg));
                  router.refresh();
                  return;
                }
              }

              router.push(postSignupPath(parsed.data.role, false));
              router.refresh();
            } catch (inner) {
              const msg = inner instanceof Error ? inner.message : "Ошибка настройки профиля.";
              setFormError(msg);
              if (parsed.data.role === "employer") {
                router.push(postSignupPath("employer", true, msg));
                router.refresh();
              }
            }
          },
          onError: (ctx) => {
            setFormError(describeSignUpError(ctx));
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
    loadingStage === "workspace"
      ? "Настраиваем рабочее пространство…"
      : loadingStage === "creating"
        ? "Создаём аккаунт…"
        : "Создать аккаунт";

  const stepIndicator = step === STEP.credentials ? 1 : step === STEP.role ? 2 : 3;

  return (
    <div className="space-y-6">
      <div
        className="flex items-center justify-between gap-2 text-xs text-zinc-500"
        aria-live="polite"
      >
        <span>
          Шаг {stepIndicator} из 3
        </span>
        <span className="font-medium text-zinc-400">
          {step === STEP.credentials ? "Аккаунт" : step === STEP.role ? "Роль" : "Профиль"}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={stepIndicator}
        aria-label="Прогресс регистрации"
      >
        <div
          className="h-full rounded-full bg-white transition-[width] duration-300 ease-out"
          style={{ width: `${(stepIndicator / 3) * 100}%` }}
        />
      </div>

      <form
        id={formId}
        onSubmit={
          step === STEP.credentials
            ? goNextFromCredentials
            : step === STEP.role
              ? goNextFromRole
              : onFinalSubmit
        }
        className="space-y-5"
        noValidate
      >
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-200"
          >
            {formError}
          </div>
        ) : null}

        {step === STEP.credentials ? (
          <>
            <div className="space-y-2">
              <label htmlFor="signup-email" className="text-sm font-medium text-zinc-300">
                Email
              </label>
              <input
                ref={emailInputRef}
                id="signup-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
                value={form.email}
                onChange={(e) => {
                  setForm((f) => ({ ...f, email: e.target.value }));
                  if (touched.email) {
                    validateEmailField();
                  } else {
                    clearFieldError("email");
                  }
                }}
                onBlur={() => {
                  setTouched((t) => ({ ...t, email: true }));
                  validateEmailField();
                }}
                className={`w-full rounded-lg border bg-black/40 px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
                  fieldErrors.email ? "border-red-500/50 focus:border-red-400/50" : "border-white/10 focus:border-white/20"
                }`}
                placeholder="you@company.com"
                disabled={loading}
              />
              {fieldErrors.email ? (
                <p id="signup-email-error" className="text-xs text-red-300" role="status">
                  {fieldErrors.email}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <label htmlFor="signup-password" className="text-sm font-medium text-zinc-300">
                Пароль
              </label>
              <div className="relative">
                <input
                  id="signup-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby="password-hint signup-password-error"
                  value={form.password}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, password: e.target.value }));
                    if (touched.password) {
                      validatePasswordField();
                    } else {
                      clearFieldError("password");
                    }
                  }}
                  onBlur={() => {
                    setTouched((t) => ({ ...t, password: true }));
                    validatePasswordField();
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
                <p id="signup-password-error" className="text-xs text-red-300" role="status">
                  {fieldErrors.password}
                </p>
              ) : null}
              <ul id="password-hint" className="space-y-1 text-xs text-zinc-500" aria-label="Требования к паролю">
                <li className={passwordChecks.length ? "text-emerald-400/90" : ""}>
                  {passwordChecks.length ? "✓" : "○"} Не менее 8 символов
                </li>
                <li className={passwordChecks.letter ? "text-emerald-400/90" : ""}>
                  {passwordChecks.letter ? "✓" : "○"} Хотя бы одна буква
                </li>
                <li className={passwordChecks.number ? "text-emerald-400/90" : ""}>
                  {passwordChecks.number ? "✓" : "○"} Хотя бы одна цифра
                </li>
              </ul>
            </div>
          </>
        ) : null}

        {step === STEP.role ? (
          <div className="space-y-3">
            <span id="signup-role-label" className="text-sm font-medium text-zinc-300">
              Кто вы?
            </span>
            <div
              className="flex flex-col gap-3 sm:flex-row"
              role="group"
              aria-labelledby="signup-role-label"
            >
              {(
                [
                  ["candidate", "Кандидат", "Ищите вакансии и проходите AI-собеседования."],
                  ["employer", "Работодатель", "Нанимайте кандидатов с помощью AI-интервьюеров."],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setForm((f) => ({ ...f, role: value }));
                  }}
                  aria-pressed={form.role === value}
                  className={`flex flex-1 flex-col rounded-xl border p-4 text-left transition ${
                    form.role === value
                      ? "border-white bg-white text-zinc-950"
                      : "border-white/10 bg-black/30 text-zinc-300 hover:border-white/20"
                  }`}
                >
                  <span className="text-sm font-semibold">{label}</span>
                  <span className={`mt-1 text-xs ${form.role === value ? "text-zinc-600" : "text-zinc-500"}`}>
                    {hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === STEP.profile ? (
          <>
            <div className="space-y-2">
              <label htmlFor="signup-name" className="text-sm font-medium text-zinc-300">
                Имя
              </label>
              <input
                ref={nameInputRef}
                id="signup-name"
                name="name"
                type="text"
                autoComplete="name"
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? "signup-name-error" : undefined}
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                  if (touched.name) {
                    validateNameField();
                  } else {
                    clearFieldError("name");
                  }
                }}
                onBlur={() => {
                  setTouched((t) => ({ ...t, name: true }));
                  validateNameField();
                }}
                className={`w-full rounded-lg border bg-black/40 px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
                  fieldErrors.name ? "border-red-500/50 focus:border-red-400/50" : "border-white/10 focus:border-white/20"
                }`}
                placeholder="Иван Иванов"
                disabled={loading}
              />
              {fieldErrors.name ? (
                <p id="signup-name-error" className="text-xs text-red-300" role="status">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>
            {form.role === "employer" ? (
              <div className="space-y-2">
                <label htmlFor="signup-company" className="text-sm font-medium text-zinc-300">
                  Название компании
                </label>
                <input
                  id="signup-company"
                  name="companyName"
                  type="text"
                  autoComplete="organization"
                  aria-invalid={Boolean(fieldErrors.companyName)}
                  aria-describedby={fieldErrors.companyName ? "signup-company-error" : undefined}
                  value={form.companyName}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, companyName: e.target.value }));
                    if (touched.companyName) {
                      validateCompanyField();
                    } else {
                      clearFieldError("companyName");
                    }
                  }}
                  onBlur={() => {
                    setTouched((t) => ({ ...t, companyName: true }));
                    validateCompanyField();
                  }}
                  className={`w-full rounded-lg border bg-black/40 px-4 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 focus:ring-white/10 ${
                    fieldErrors.companyName ? "border-red-500/50 focus:border-red-400/50" : "border-white/10 focus:border-white/20"
                  }`}
                  placeholder="Название вашей компании"
                  disabled={loading}
                />
                {fieldErrors.companyName ? (
                  <p id="signup-company-error" className="text-xs text-red-300" role="status">
                    {fieldErrors.companyName}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {step > STEP.credentials ? (
            <button
              type="button"
              onClick={goBack}
              disabled={loading}
              className="order-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-white/5 disabled:opacity-50 sm:order-1"
            >
              Назад
            </button>
          ) : (
            <span className="order-2 sm:order-1" />
          )}
          <button
            type="submit"
            form={formId}
            disabled={loading}
            aria-busy={loading}
            className="order-1 inline-flex w-full items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 sm:order-2 sm:w-auto sm:min-w-[160px]"
          >
            {loading ? loadingLabel : step === STEP.profile ? "Создать аккаунт" : "Далее"}
          </button>
        </div>
      </form>

      <p className="text-center text-sm text-zinc-500">
        Уже есть аккаунт?{" "}
        <Link href="/sign-in" className="font-medium text-white underline-offset-4 hover:text-zinc-200 hover:underline">
          Войти
        </Link>
      </p>
    </div>
  );
}
