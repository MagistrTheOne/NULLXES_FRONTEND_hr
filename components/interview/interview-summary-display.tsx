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
import { cn } from "@/lib/utils";

type InterviewSummaryDisplayProps = {
  summary: InterviewSummaryPayload | null;
  title?: string;
  defaultOpen?: boolean;
};

interface DecisionTone {
  label: string;
  ring: string;
  text: string;
  bg: string;
  bar: string;
  Icon: typeof ShieldCheck;
}

function decisionTone(decision: InterviewDecision): DecisionTone {
  if (decision === "recommended") {
    return {
      label: decisionLabel(decision),
      ring: "ring-emerald-200",
      text: "text-emerald-900",
      bg: "bg-emerald-50",
      bar: "bg-emerald-500",
      Icon: ShieldCheck
    };
  }
  if (decision === "rejected") {
    return {
      label: decisionLabel(decision),
      ring: "ring-rose-200",
      text: "text-rose-900",
      bg: "bg-rose-50",
      bar: "bg-rose-500",
      Icon: ShieldX
    };
  }
  return {
    label: decisionLabel(decision),
    ring: "ring-amber-200",
    text: "text-amber-900",
    bg: "bg-amber-50",
    bar: "bg-amber-500",
    Icon: ShieldAlert
  };
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0;
  const tone = safe >= 7.5 ? "bg-emerald-500" : safe >= 5.5 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-600">{label}</span>
        <span className="font-mono text-sm font-semibold text-slate-800">{safe.toFixed(1)} / 10</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${(safe / 10) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function InterviewSummaryDisplay({
  summary,
  title = "Итог интервью",
  defaultOpen = true
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
    <Card className={cn("rounded-2xl border-0 ring-1 shadow-sm bg-white/95", tone.ring)}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-3 pt-4">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg text-left outline-none">
            <div className="flex min-w-0 items-center gap-3">
              <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tone.bg, tone.text)}>
                <Icon className="size-5" />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-base text-slate-800">{title}</CardTitle>
                <p className={cn("mt-0.5 text-sm font-semibold", tone.text)}>
                  Решение · {tone.label} · {scoreTotal.toFixed(1)} / 10
                </p>
              </div>
            </div>
            <ChevronDown
              className={cn("size-5 shrink-0 text-slate-500 transition-transform", open && "rotate-180")}
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-5 border-t border-slate-100 pt-4 text-sm text-slate-700">
            {/* Confidence */}
            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold uppercase tracking-wide text-slate-500">Уверенность модели</span>
                <span className="font-mono text-sm font-semibold text-slate-800">{confidence}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={cn("h-full rounded-full transition-all", tone.bar)}
                  style={{ width: `${confidence}%` }}
                />
              </div>
            </div>

            {/* 4 Scores */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ScoreBar label="Опыт" value={normalized.scores4.experience} />
              <ScoreBar label="Коммуникация" value={normalized.scores4.communication} />
              <ScoreBar label="Мышление" value={normalized.scores4.thinking} />
              <ScoreBar label="Работа с возражениями" value={normalized.scores4.objections} />
            </div>

            {/* Key findings */}
            {normalized.keyFindings.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ключевые выводы</p>
                <ul className="mt-1.5 space-y-1.5">
                  {normalized.keyFindings.map((finding, i) => (
                    <li key={i} className="leading-snug text-slate-700">
                      {finding}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Risks */}
            {normalized.risks.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Риски</p>
                <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-slate-700">
                  {normalized.risks.map((risk, i) => (
                    <li key={i} className="leading-snug">
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Recommended next step */}
            <div className={cn("rounded-xl px-4 py-3", tone.bg, tone.text)}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Рекомендация</p>
              <p className="mt-0.5 text-sm font-medium">{normalized.recommendedNextStep}</p>
            </div>

            {normalized.notes ? <p className="text-[11px] text-slate-400">{normalized.notes}</p> : null}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
