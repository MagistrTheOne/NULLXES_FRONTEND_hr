"use client";

import type { InterviewFlowPhase } from "@/hooks/use-interview-session";

interface InterviewPhaseIndicatorProps {
  flowPhase: InterviewFlowPhase;
  questionsAsked: number;
  totalQuestions: number;
}

export function InterviewPhaseIndicator({
  flowPhase,
  questionsAsked,
  totalQuestions
}: InterviewPhaseIndicatorProps) {
  if (flowPhase === "lobby" || flowPhase === "completed") return null;

  let label: string;
  if (flowPhase === "intro") {
    label = "Знакомство";
  } else if (flowPhase === "closing") {
    label = "Заключительная часть";
  } else if (totalQuestions > 0) {
    const safeAsked = Math.min(questionsAsked + 1, totalQuestions);
    label = `Вопрос ${safeAsked} из ${totalQuestions}`;
  } else {
    label = "Интервью идёт";
  }

  return (
    <div className="flex w-full justify-center">
      <span className="rounded-full border border-slate-300/70 bg-white/70 px-4 py-1 text-xs font-medium uppercase tracking-wide text-slate-600 shadow-sm">
        {label}
      </span>
    </div>
  );
}
