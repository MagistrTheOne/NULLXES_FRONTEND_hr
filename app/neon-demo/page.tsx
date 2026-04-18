import { sql } from "@/app/lib/db";

export const dynamic = "force-dynamic";

async function getDbVersion() {
  const result = await sql`SELECT version()`;
  return result[0].version as string;
}

export default async function NeonDemoPage() {
  const version = await getDbVersion();
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Next.js + Neon</h1>
      <p className="mt-2 text-slate-700">PostgreSQL Version: {version}</p>
      <p className="mt-4 max-w-xl text-sm text-slate-500">
        This page uses <code className="rounded bg-slate-100 px-1">dynamic = &apos;force-dynamic&apos;</code> so the
        version query runs on every request (no static caching). See Next.js caching docs for other strategies.
      </p>
    </main>
  );
}
