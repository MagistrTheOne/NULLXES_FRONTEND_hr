"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type InterviewSummaryDisplayProps = {
  summary: InterviewSummaryPayload | null;
  title?: string;
  /** По умолчанию блок свёрнут — разворачивается по клику. */
  defaultOpen?: boolean;
};

export function InterviewSummaryDisplay({
  summary,
  title = "Итог интервью",
  defaultOpen = false
}: InterviewSummaryDisplayProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!summary) {
    return null;
  }

  return (
    <Card className="rounded-2xl border border-slate-200 bg-white/90 shadow-sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-2 pt-4">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-lg text-left outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-slate-400">
            <CardTitle className="text-base text-slate-800">{title}</CardTitle>
            <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
              {open ? "Свернуть" : "Показать полностью"}
              <ChevronDown className={`size-5 shrink-0 text-slate-600 transition-transform ${open ? "rotate-180" : ""}`} />
            </span>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3 border-t border-slate-100 pt-4 text-sm text-slate-700">
            <div className="flex flex-wrap gap-1.5 pb-1">
              <Badge variant="outline">v{summary.summarySchemaVersion}</Badge>
              <Badge variant="secondary">{summary.verdict}</Badge>
              {summary.hiringRecommendation ? (
                <Badge variant="outline">hire: {summary.hiringRecommendation}</Badge>
              ) : null}
              <Badge variant="outline">confidence: {summary.confidence}</Badge>
              {summary.evaluationPending ? (
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
                  scores pending
                </Badge>
              ) : null}
            </div>
            <p className="font-medium text-slate-800">{summary.roleFit}</p>
            {summary.vacancyDigest ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Текст вакансии (в контексте)</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
                  {summary.vacancyDigest}
                </p>
              </div>
            ) : null}
            {summary.vacancyTruncated ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Текст вакансии был сокращён при передаче в модель (лимит контекста).
              </p>
            ) : null}
            {summary.strengths.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Сильные стороны</p>
                <ul className="mt-1 list-inside list-disc text-slate-700">
                  {summary.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.scores &&
            (summary.scores.experience1to10 != null ||
              summary.scores.communication1to10 != null ||
              summary.scores.thinking1to10 != null) ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Оценка (1–10)</p>
                <ul className="mt-1 list-inside text-xs text-slate-700">
                  {summary.scores.experience1to10 != null ? (
                    <li>Опыт: {summary.scores.experience1to10}</li>
                  ) : null}
                  {summary.scores.communication1to10 != null ? (
                    <li>Коммуникация: {summary.scores.communication1to10}</li>
                  ) : null}
                  {summary.scores.thinking1to10 != null ? (
                    <li>Мышление / структура ответов: {summary.scores.thinking1to10}</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            {summary.weaknesses && summary.weaknesses.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Слабые стороны</p>
                <ul className="mt-1 list-inside list-disc text-slate-700">
                  {summary.weaknesses.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.gaps.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Пробелы</p>
                <ul className="mt-1 list-inside list-disc text-slate-700">
                  {summary.gaps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.questionCoverage.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Вопросы</p>
                <ul className="mt-1 space-y-1">
                  {summary.questionCoverage.map((q) => (
                    <li key={q.order} className="rounded-md bg-slate-50 px-2 py-1 text-xs">
                      <span className="font-medium">#{q.order}</span> {q.topic}{" "}
                      <span className="text-slate-500">({q.assessment})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>
              <span className="font-semibold text-slate-800">Рекомендация:</span> {summary.recommendedNextStep}
            </p>
            {summary.notes ? <p className="text-xs text-slate-500">{summary.notes}</p> : null}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
