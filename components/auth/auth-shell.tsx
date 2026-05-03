import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

export function AuthShell({ title, subtitle, children }: Props) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#dfe4ed] px-4 py-12">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,119,198,0.12),transparent)]"
        aria-hidden
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
        <div className="rounded-2xl border border-slate-200/90 bg-zinc-900/95 p-8 shadow-xl shadow-slate-900/10 backdrop-blur-xl">
          {children}
        </div>
      </div>
    </div>
  );
}
