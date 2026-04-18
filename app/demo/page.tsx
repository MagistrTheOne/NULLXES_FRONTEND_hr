import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { StartDemoButton } from "@/components/demo/start-demo-button";
import { isDemoSession } from "@/lib/demo-session";
import { getServerSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Demo",
};

export default async function DemoPage() {
  const session = await getServerSession();
  const demo = await isDemoSession();

  if (session || demo) {
    return (
      <AuthShell
        title="Demo mode"
        subtitle="Explore the product without a full account. Registration stays separate until you sign up."
      >
        <div className="space-y-4 text-sm text-zinc-400">
          {session ? (
            <p>
              You are signed in as <span className="text-zinc-200">{session.user.email}</span>. Demo cookie is ignored
              for data writes; use the dashboard for account features.
            </p>
          ) : (
            <p>Demo session is active (HTTP-only cookie). No user row is created in the database.</p>
          )}
          <Link
            href="/"
            className="inline-flex w-full items-center justify-center rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/10"
          >
            Continue to app home
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Try JOB AI"
      subtitle="Start a time-limited demo session. No email or password required."
    >
      <StartDemoButton />
      <p className="mt-6 text-center text-xs text-zinc-500">
        Prefer a full account?{" "}
        <Link href="/sign-up" className="text-zinc-300 underline-offset-4 hover:underline">
          Sign up
        </Link>
      </p>
    </AuthShell>
  );
}
