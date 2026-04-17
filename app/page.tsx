import { Suspense } from "react";
import { InterviewShell } from "@/components/interview/interview-shell";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#dfe4ec] text-slate-600">Загрузка…</div>}>
      <InterviewShell />
    </Suspense>
  );
}
