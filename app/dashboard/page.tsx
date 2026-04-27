import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { company, companyMember } from "@/db/schema";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";

export const metadata: Metadata = {
  title: "Dashboard",
};

type DashboardSearchParams = {
  employerOnboarding?: string;
  onboardingError?: string;
  welcome?: string;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<DashboardSearchParams | Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuth();
  const role = (session.user as { role?: string }).role ?? "candidate";

  const sp = searchParams ? await searchParams : {};
  const employerPending =
    typeof (sp as DashboardSearchParams).employerOnboarding === "string" &&
    (sp as DashboardSearchParams).employerOnboarding === "pending";
  const onboardingErrorRaw = (sp as DashboardSearchParams).onboardingError;
  const onboardingError = typeof onboardingErrorRaw === "string" ? onboardingErrorRaw : null;

  let companyLabel: string | null = null;
  if (role === "employer") {
    const row = await db
      .select({ name: company.name })
      .from(companyMember)
      .innerJoin(company, eq(companyMember.companyId, company.id))
      .where(eq(companyMember.userId, session.user.id))
      .limit(1);
    companyLabel = row[0]?.name ?? null;
  }

  return (
    <div className="relative min-h-screen w-full min-w-0 overflow-x-hidden bg-zinc-950 text-zinc-100">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,119,198,0.15),transparent)]"
        aria-hidden
      />
      <div className="relative mx-auto flex min-h-screen w-full min-w-0 max-w-3xl flex-col px-4 py-10 sm:px-6 sm:py-16">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:pb-8">
          <div>
            <p className="text-sm font-medium text-zinc-500">Signed in as</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{session.user.name}</h1>
            <p className="mt-1 text-sm text-zinc-400">{session.user.email}</p>
            <p className="mt-2 text-xs uppercase tracking-wide text-zinc-500">
              Role: <span className="text-zinc-300">{role}</span>
              {companyLabel ? (
                <>
                  {" "}
                  · Company: <span className="text-zinc-300">{companyLabel}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="w-full shrink-0 sm:w-auto sm:self-start">
            <SignOutButton />
          </div>
        </header>
        <main className="mt-8 min-w-0 space-y-6 sm:mt-12">
          {employerPending && role === "employer" ? (
            <div
              role="status"
              className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-4 py-3 text-sm text-amber-100"
            >
              <p className="font-medium">Company workspace not linked</p>
              <p className="mt-1 text-amber-200/90">
                Your account was created, but saving the company failed
                {onboardingError ? ` (${onboardingError})` : ""}. Try again from account settings or contact support.
              </p>
            </div>
          ) : null}
          <div className="rounded-2xl border border-white/10 bg-zinc-900/40 p-5 backdrop-blur-xl sm:p-8">
          <p className="text-sm leading-relaxed text-zinc-400">
            Protected route — session validated on the server. Job offers and applications can be built on top of{" "}
            <code className="rounded bg-black/40 px-1 text-zinc-300">company</code> /{" "}
            <code className="rounded bg-black/40 px-1 text-zinc-300">job_offer</code>.
          </p>
          </div>
        </main>
      </div>
    </div>
  );
}
