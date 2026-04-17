"use client";

import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type InterviewSummaryDisplayProps = {
  summary: InterviewSummaryPayload | null;
  title?: string;
};

export function InterviewSummaryDisplay({ summary, title = "Итог интервью" }: InterviewSummaryDisplayProps) {
  if (!summary) {
    return null;
  }

  return (
    <Card className="rounded-2xl border border-slate-200 bg-white/90 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base text-slate-800">{title}</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">v{summary.summarySchemaVersion}</Badge>
            <Badge variant="secondary">{summary.verdict}</Badge>
            <Badge variant="outline">confidence: {summary.confidence}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        <p className="font-medium text-slate-800">{summary.roleFit}</p>
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
    </Card>
  );
}
