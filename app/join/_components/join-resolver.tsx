import { redirect } from "next/navigation";
import Link from "next/link";

import type { JoinLinkRole } from "@/lib/api";

type ResolveSuccess = {
  status: "ok";
  jobAiId: number;
  role: JoinLinkRole;
  expiresAt: number;
  displayName?: string;
};

type ResolveExpired = { status: "expired"; expiredAt?: number };
type ResolveRevoked = { status: "revoked" };
type ResolveInvalid = { status: "invalid"; reason?: string };
type ResolveUnavailable = { status: "unavailable" };

type ResolveResult =
  | ResolveSuccess
  | ResolveExpired
  | ResolveRevoked
  | ResolveInvalid
  | ResolveUnavailable;

async function resolveToken(role: JoinLinkRole, token: string): Promise<ResolveResult> {
  const backendUrl = (process.env.BACKEND_GATEWAY_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  let response: Response | null;
  try {
    response = await fetch(`${backendUrl}/join/${role}/${encodeURIComponent(token)}`, {
      method: "GET",
      cache: "no-store"
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response) {
    return { status: "unavailable" };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (response.status === 200 && body) {
    const jobAiId = Number(body.jobAiId);
    const expiresAt = Number(body.expiresAt);
    if (!Number.isInteger(jobAiId) || jobAiId <= 0 || !Number.isFinite(expiresAt)) {
      return { status: "invalid", reason: "malformed_response" };
    }
    return {
      status: "ok",
      jobAiId,
      role,
      expiresAt,
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {})
    };
  }

  const reason = typeof body?.error === "string" ? body.error : undefined;
  if (response.status === 410) {
    if (reason === "revoked") {
      return { status: "revoked" };
    }
    const expiredAt = typeof body?.expiredAt === "number" ? body.expiredAt : undefined;
    return { status: "expired", expiredAt };
  }
  if (response.status === 401) {
    return { status: "invalid", reason };
  }
  return { status: "unavailable" };
}

interface JoinResolverProps {
  role: JoinLinkRole;
  token: string;
}

export async function JoinResolver({ role, token }: JoinResolverProps) {
  const result = await resolveToken(role, token);

  if (result.status === "ok") {
    const params = new URLSearchParams();
    params.set("jobAiId", String(result.jobAiId));
    if (role === "candidate") {
      params.set("entry", "candidate");
    }
    const target = role === "candidate" ? `/?${params.toString()}` : `/spectator?${params.toString()}`;
    redirect(target);
  }

  return <JoinErrorScreen result={result} role={role} />;
}

function JoinErrorScreen({
  result,
  role
}: {
  result: Exclude<ResolveResult, ResolveSuccess>;
  role: JoinLinkRole;
}) {
  const { title, body } = describeError(result, role);
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#dfe4ec] px-4 py-10 text-slate-700">
      <section className="w-full max-w-md rounded-2xl bg-[#d9dee7] px-8 py-10 shadow-[-10px_-10px_20px_rgba(255,255,255,.9),10px_10px_22px_rgba(163,177,198,.55)]">
        <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">{body}</p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700"
        >
          На главную
        </Link>
      </section>
    </main>
  );
}

function describeError(
  result: Exclude<ResolveResult, ResolveSuccess>,
  role: JoinLinkRole
): { title: string; body: string } {
  const who = role === "candidate" ? "кандидата" : "наблюдателя";
  switch (result.status) {
    case "expired": {
      const when = result.expiredAt ? new Date(result.expiredAt).toLocaleString("ru-RU") : null;
      return {
        title: "Ссылка истекла",
        body: when
          ? `Время действия ссылки ${who} закончилось ${when}. Попросите HR выслать новую ссылку.`
          : `Время действия ссылки ${who} закончилось. Попросите HR выслать новую ссылку.`
      };
    }
    case "revoked":
      return {
        title: "Ссылка отозвана",
        body: `HR отозвал эту ссылку ${who}. Попросите выслать новую.`
      };
    case "invalid":
      return {
        title: "Ссылка недействительна",
        body: "Похоже, ссылку случайно изменили. Откройте её ещё раз из исходного письма или попросите HR выслать заново."
      };
    case "unavailable":
    default:
      return {
        title: "Сервис временно недоступен",
        body: "Не удалось проверить ссылку. Попробуйте обновить страницу через минуту."
      };
  }
}
