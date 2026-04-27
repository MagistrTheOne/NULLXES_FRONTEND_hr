import { Suspense } from "react";
import { InterviewShell } from "@/components/interview/interview-shell";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen w-full min-w-0 items-center justify-center bg-[#dfe4ec] px-4 text-center text-slate-600">
          Загрузка…
        </div>
      }
    >
      <InterviewShell />
    </Suspense>
  );
}
