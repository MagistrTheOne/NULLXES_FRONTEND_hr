"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Hourglass,
  Loader2,
  Play,
  RefreshCw,
  Radio,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  InterviewStatusIcon,
  InterviewStatusTone,
  InterviewStatusView
} from "@/lib/interview-status";

const ICONS: Record<InterviewStatusIcon, LucideIcon> = {
  play: Play,
  hourglass: Hourglass,
  loader: Loader2,
  radio: Radio,
  alertTriangle: AlertTriangle,
  refresh: RefreshCw,
  checkCircle: CheckCircle2
};
const TONES: Record<InterviewStatusTone, { container: string; dot: string; icon: string }> = {
  slate: {
    container: "bg-slate-200/80 text-slate-700 ring-1 ring-inset ring-slate-300/60",
    dot: "bg-slate-400",
    icon: "text-slate-500"
  },
  amber: {
    container: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-200",
    dot: "bg-amber-500",
    icon: "text-amber-600"
  },
  emerald: {
    container: "bg-emerald-100 text-emerald-900 ring-1 ring-inset ring-emerald-200",
    dot: "bg-emerald-500",
    icon: "text-emerald-600"
  },
  rose: {
    container: "bg-rose-100 text-rose-900 ring-1 ring-inset ring-rose-200",
    dot: "bg-rose-500",
    icon: "text-rose-600"
  },
  sky: {
    container: "bg-sky-100 text-sky-900 ring-1 ring-inset ring-sky-200",
    dot: "bg-sky-500",
    icon: "text-sky-600"
  }
};

const SPINNING: Partial<Record<InterviewStatusIcon, true>> = {
  loader: true,
  refresh: true
};

const PULSING: Partial<Record<InterviewStatusIcon, true>> = {
  radio: true
};

interface InterviewStatusBadgeProps {
  status: InterviewStatusView;
  className?: string;
  compact?: boolean;
}

export function InterviewStatusBadge({ status, className, compact = false }: InterviewStatusBadgeProps) {
  const tone = TONES[status.tone];
  const Icon = ICONS[status.icon];
  return (
    <span
      role="status"
      aria-label={status.ariaLabel}
      className={cn(
        "inline-flex h-6 shrink-0 select-none items-center gap-1.5 rounded-full px-2.5 text-xs font-medium leading-none",
        tone.container,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot, PULSING[status.icon] && "animate-pulse")} />
      <Icon
        aria-hidden
        className={cn("size-3.5", tone.icon, SPINNING[status.icon] && "animate-spin")}
      />
      {compact ? null : <span>{status.label}</span>}
    </span>
  );
}
