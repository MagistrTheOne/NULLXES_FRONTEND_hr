"use client";

import { ChevronDown, ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { useState } from "react";
import {
  decisionLabel,
  normalizeInterviewSummary,
  type InterviewDecision,
  type InterviewSummaryPayload
} from "@/lib/interview-summary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type InterviewSummaryDisplayProps = {
  summary: InterviewSummaryPayload | null;
  title?: string;
  /**
   * Default collapsed now — user asked explicitly for the card to not occupy
   * the full screen after opening. Full details show only on demand.
   */
  defaultOpen?: boolean;
};

interface DecisionTone {
  label: string;
  ring: string;
  text: string;
  bg: string;
  badge: string;
  barFrom: string;
  barTo: string;
  Icon: typeof ShieldCheck;
}

function decisionTone(decision: InterviewDecision): DecisionTone {
  if (decision === "recommended") {
    return {
      label: decisionLabel(decision),
      ring: "ring-emerald-200/70",
      text: "text-emerald-700",
      bg: "bg-emerald-50",
      badge: "bg-emerald-100 text-emerald-800 border-emerald-200",
      barFrom: "from-emerald-400",
      barTo: "to-emerald-600",
      Icon: ShieldCheck
    };
  }
  if (decision === "rejected") {
    return {
      label: decisionLabel(decision),
      ring: "ring-rose-200/70",
      text: "text-rose-700",
      bg: "bg-rose-50",
      badge: "bg-rose-100 text-rose-800 border-rose-200",
      barFrom: "from-rose-400",
      barTo: "to-rose-600",
      Icon: ShieldX
    };
  }
  return {
    label: decisionLabel(decision),
    ring: "ring-amber-200/70",
    text: "text-amber-700",
    bg: "bg-amber-50",
    badge: "bg-amber-100 text-amber-800 border-amber-200",
    barFrom: "from-amber-400",
    barTo: "to-amber-600",
    Icon: ShieldAlert
  };
}

function scoreTone(value: number): { from: string; to: string } {
  if (value >= 7.5) return { from: "from-emerald-400", to: "to-emerald-600" };
  if (value >= 5.0) return { from: "from-amber-400", to: "to-amber-600" };
  return { from: "from-rose-400", to: "to-rose-600" };
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0;
  const tone = scoreTone(safe);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate font-medium text-slate-600">{label}</span>
        <span className="font-mono text-xs font-semibold tabular-nums text-slate-800">
          {safe.toFixed(1)}
          <span className="text-slate-400"> /10</span>
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200/60">
        <div
          className={cn("h-full rounded-full bg-linear-to-r transition-all duration-500 ease-out", tone.from, tone.to)}
          style={{ width: `${(safe / 10) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function InterviewSummaryDisplay({
  summary,
  title = "Итог интервью",
  defaultOpen = false
}: InterviewSummaryDisplayProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Защита от старых v1 payload'ов в Redis: если payload не v2 — нормализуем
  // его до v2 на лету. Без этого `summary.scores4.experience` крашит UI на
  // завершённых интервью, сделанных до bump'а схемы.
  const normalized = summary ? normalizeInterviewSummary(summary) : null;
  if (!normalized) return null;

  const tone = decisionTone(normalized.decision);
  const Icon = tone.Icon;
  const confidence = Math.max(0, Math.min(100, Math.round(normalized.confidencePercent ?? 0)));
  const scoreTotal = Number.isFinite(normalized.scoreTotal) ? normalized.scoreTotal : 0;

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl border-0 bg-white/95 shadow-sm ring-1 transition-shadow",
        tone.ring,
        open && "shadow-md"
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="gap-0 px-4 py-3">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-xl",
                  tone.bg,
                  tone.text
                )}
              >
                <Icon className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <CardTitle className="truncate text-sm font-semibold text-slate-800">{title}</CardTitle>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge variant="outline" className={cn("h-5 rounded-full px-2 font-medium", tone.badge)}>
                    {tone.label}
                  </Badge>
                  <span className="font-mono text-xs font-semibold tabular-nums text-slate-700">
                    {scoreTotal.toFixed(1)}
                    <span className="text-slate-400"> /10</span>
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">уверенность {confidence}%</span>
                </div>
              </div>
            </div>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-slate-400 transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3.5 border-t border-slate-100/80 px-4 pb-4 pt-3 text-sm text-slate-700">
            {/* Confidence */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-semibold uppercase tracking-wide text-slate-500">Уверенность</span>
                <span className="font-mono text-xs font-semibold tabular-nums text-slate-800">{confidence}%</span>
              </div>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200/60">
                <div
                  className={cn(
                    "h-full rounded-full bg-linear-to-r transition-all duration-500 ease-out",
                    tone.barFrom,
                    tone.barTo
                  )}
                  style={{ width: `${confidence}%` }}
                />
              </div>
            </div>

            {/* 4 Scores */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <ScoreBar label="Опыт" value={normalized.scores4.experience} />
              <ScoreBar label="Коммуникация" value={normalized.scores4.communication} />
              <ScoreBar label="Мышление" value={normalized.scores4.thinking} />
              <ScoreBar label="Возражения" value={normalized.scores4.objections} />
            </div>

            {/* Key findings */}
            {normalized.keyFindings.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ключевые выводы</p>
                <ul className="space-y-1 text-[13px] leading-snug text-slate-700">
                  {normalized.keyFindings.map((finding, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-slate-400" aria-hidden />
                      <span>{finding}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Risks */}
            {normalized.risks.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Риски</p>
                <ul className="space-y-1 text-[13px] leading-snug text-slate-700">
                  {normalized.risks.map((risk, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-rose-400" aria-hidden />
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Recommended next step */}
            <div className={cn("rounded-xl px-3 py-2", tone.bg)}>
              <p className={cn("text-[11px] font-semibold uppercase tracking-wide opacity-80", tone.text)}>
                Рекомендация
              </p>
              <p className={cn("mt-0.5 text-[13px] font-medium leading-snug", tone.text)}>
                {normalized.recommendedNextStep}
              </p>
            </div>

            {normalized.notes ? (
              <p className="text-[10px] leading-snug text-slate-400">{normalized.notes}</p>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
