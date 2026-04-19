"use client";

import type { AgentState } from "@/hooks/use-interview-session";

interface AgentStateIndicatorProps {
  state: AgentState;
  className?: string;
}

const LABELS: Record<AgentState, { text: string; dot: string }> = {
  idle: { text: "Ожидает", dot: "bg-slate-400" },
  listening: { text: "Слушает", dot: "bg-emerald-500" },
  thinking: { text: "Думает", dot: "bg-amber-500" },
  speaking: { text: "Говорит", dot: "bg-sky-500 animate-pulse" }
};

export function AgentStateIndicator({ state, className }: AgentStateIndicatorProps) {
  const config = LABELS[state];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full bg-black/40 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm ${
        className ?? ""
      }`}
      aria-live="polite"
      aria-label={`Состояние HR-ассистента: ${config.text}`}
    >
      <span className={`h-2 w-2 rounded-full ${config.dot}`} />
      {config.text}
    </span>
  );
}
