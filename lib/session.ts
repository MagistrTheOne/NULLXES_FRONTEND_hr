import { auth } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo-session";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireAuth() {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in");
  }
  return session;
}

/** Better Auth session or signed demo cookie — no mixing of persisted user rows for demo. */
export async function getRegisteredSessionOrDemo() {
  const session = await getServerSession();
  if (session) {
    return { kind: "session" as const, session };
  }
  if (await isDemoSession()) {
    return { kind: "demo" as const };
  }
  return null;
}
