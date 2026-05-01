"use client";

import type { InterviewFlowPhase } from "@/hooks/use-interview-session";

interface InterviewPhaseIndicatorProps {
  flowPhase: InterviewFlowPhase;
}

export function InterviewPhaseIndicator({
  flowPhase
}: InterviewPhaseIndicatorProps) {
  if (flowPhase === "lobby" || flowPhase === "completed") return null;

  let label: string;
  if (flowPhase === "intro") {
    label = "Знакомство";
  } else if (flowPhase === "questions") {
    label = "Тех. вопросы";
  } else if (flowPhase === "closing") {
    label = "Конец";
  } else {
    label = "Интервью идёт";
  }

  return (
    <div className="flex w-full min-w-0 justify-center px-1">
      <span className="max-w-full rounded-full border border-slate-300/70 bg-white/70 px-3 py-1.5 text-center text-[11px] font-medium uppercase leading-snug tracking-wide text-slate-600 shadow-sm sm:px-4 sm:py-1 sm:text-xs">
        {label}
      </span>
    </div>
  );
}
