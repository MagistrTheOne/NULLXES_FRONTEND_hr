import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { extractJobAiIdFromEntryUrl } from "@/lib/candidate-entry-url";
import { cn } from "@/lib/utils";
import type { InterviewStatusView } from "@/lib/interview-status";
import { InterviewStatusBadge } from "./interview-status-badge";

type MeetingHeaderProps = {
  /** Презентационный статус интервью (label + tone + icon). */
  status: InterviewStatusView;
  /** Сырое значение InterviewPhase — для legacy debug-режима. */
  rawStatusLabel?: string;
  meetingId: string | null;
  sessionId: string | null;
  jobAiId?: number;
  companyName?: string;
  jobTitle?: string;
  meetingAt?: string;
  prototypeEntryUrl?: string;
  onEntryUrlCommit?: (value: string) => void;
  candidateFio: string;
  candidateFirstName?: string;
  onStart: () => void;
  onStopSession?: () => void;
  stopSessionDisabled?: boolean;
  onFail?: () => void;
  startDisabled?: boolean;
  failDisabled?: boolean;
  showDebugActions?: boolean;
  /**
   * Если true — рендерим карточку для кандидата (нарративный тон, без операторских
   * кнопок, без технических идентификаторов, без URL-копирования).
   */
  candidateMode?: boolean;
  /**
   * "Активная фаза" — true когда интервью идёт прямо сейчас. Используется для
   * иерархии CTA: в idle Start = primary, Stop = disabled outline; в active
   * наоборот, чтобы оператор не путался какая кнопка главная.
   */
  interviewActive?: boolean;
};

function formatRelativeMeetingTime(meetingAt: string | undefined): string | null {
  if (!meetingAt) return null;
  const ts = new Date(meetingAt).getTime();
  if (!Number.isFinite(ts)) return null;
  const diffMs = ts - Date.now();
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  if (Math.abs(diffMs) < 90_000) return "Сейчас";
  if (diffMs > 0 && absMin < 60) return `Через ${absMin} мин`;
  if (diffMs < 0 && absMin < 60) return `${absMin} мин назад`;
  // fall back to absolute time
  return new Date(ts).toLocaleString("ru-RU");
}

export function MeetingHeader({
  status,
  rawStatusLabel,
  meetingId,
  sessionId,
  jobAiId,
  companyName,
  jobTitle,
  meetingAt,
  prototypeEntryUrl,
  onEntryUrlCommit,
  candidateFio,
  candidateFirstName,
  onStart,
  onStopSession,
  stopSessionDisabled = true,
  onFail,
  startDisabled = false,
  failDisabled = true,
  showDebugActions = false,
  candidateMode = false,
  interviewActive = false
}: MeetingHeaderProps) {
  const [entryUrlInput, setEntryUrlInput] = useState(prototypeEntryUrl ?? "");
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setEntryUrlInput(prototypeEntryUrl ?? "");
    });
  }, [prototypeEntryUrl]);

  const canonicalUrl = (prototypeEntryUrl ?? "").trim();
  const hasCopySource = Boolean(canonicalUrl || entryUrlInput.trim());
  const meetingAtAbsolute = meetingAt ? new Date(meetingAt).toLocaleString("ru-RU") : "—";
  const meetingAtRelative = useMemo(() => formatRelativeMeetingTime(meetingAt), [meetingAt]);
  const greeting = candidateFirstName?.trim() || candidateFio.split(" ")[0] || "";

  return (
    <header className="flex w-full min-w-0 flex-col items-center gap-6 sm:gap-8 md:gap-10">
      <div className="flex w-full justify-center pt-1">
        <h1
          className={cn(
            "text-center font-black tracking-tight text-[#0f1114] sm:text-5xl md:text-6xl",
            candidateMode ? "text-2xl sm:text-4xl" : "text-3xl sm:text-4xl"
          )}
        >
          JOB <span className="rounded-xl bg-sky-500 px-3 py-1 text-white">AI</span>
        </h1>
      </div>

      {candidateMode ? null : (
        <div className="w-full max-w-xl space-y-2 px-0 sm:px-1">
          <p className="text-center text-xs leading-relaxed text-slate-500 sm:text-left">
            Выберите интервью в списке ниже — здесь появится ссылка для отправки кандидату.
          </p>
          <div className="flex items-stretch gap-2 rounded-xl bg-[#d9dee7] p-2 shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
            <Input
              value={entryUrlInput}
              onChange={(e) => setEntryUrlInput(e.target.value)}
              onBlur={() => onEntryUrlCommit?.(entryUrlInput)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onEntryUrlCommit?.(entryUrlInput);
                }
              }}
              placeholder="Ссылка для отправки кандидату"
              className="min-h-12 flex-1 rounded-lg border border-transparent bg-white/70 py-3 text-base leading-normal text-slate-800 shadow-none placeholder:text-slate-400 focus-visible:ring-1 focus-visible:ring-slate-300/60"
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              disabled={!hasCopySource}
              className="h-12 w-12 shrink-0 rounded-lg border border-slate-300/50 bg-white/80 text-slate-600 shadow-sm disabled:opacity-40"
              title={hasCopySource ? "Скопировать ссылку для кандидата" : "Сначала выберите интервью в списке ниже"}
              onClick={() => {
                const text = (canonicalUrl || entryUrlInput.trim()).trim();
                if (!text) return;
                setEntryUrlInput(text);
                void navigator.clipboard.writeText(text);
                if (!extractJobAiIdFromEntryUrl(text)) {
                  toast.error("Ссылка повреждена", {
                    description: "Выберите интервью заново — в ссылке отсутствует идентификатор."
                  });
                  return;
                }
                onEntryUrlCommit?.(text);
                toast.success("Ссылка для кандидата скопирована", {
                  description: "Можно отправить кандидату по почте или мессенджеру."
                });
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <Card
        className={cn(
          "w-full max-w-xl min-w-0 rounded-2xl border-0 bg-[#d9dee7] shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]",
          candidateMode && "max-w-sm sm:max-w-xl"
        )}
      >
        <CardHeader className={cn("space-y-1", candidateMode ? "pb-2 sm:pb-3" : "pb-3")}>
          <CardTitle className="text-base font-semibold text-slate-600">
            {candidateMode ? "Ваше интервью" : "Управление интервью"}
          </CardTitle>
        </CardHeader>
        <CardContent className={cn("text-sm text-slate-600", candidateMode ? "space-y-3 sm:space-y-4" : "space-y-4")}>
          {candidateMode ? (
            <div className="space-y-2">
              {greeting ? (
                <p className="text-base font-medium text-slate-800">Здравствуйте, {greeting}!</p>
              ) : null}
              {jobTitle && companyName ? (
                <p className="text-sm leading-relaxed text-slate-600">
                  Это интервью на позицию <span className="font-medium text-slate-800">«{jobTitle}»</span> в компанию{" "}
                  <span className="font-medium text-slate-800">{companyName}</span>.
                </p>
              ) : null}
              {meetingAtRelative ? (
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Время интервью · {meetingAtRelative}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 text-slate-500 sm:grid-cols-2">
              <p>
                Кандидат · <span className="font-medium text-slate-700">{candidateFio || "—"}</span>
              </p>
              <p>
                Компания · <span className="font-medium text-slate-700">{companyName ?? "—"}</span>
              </p>
              {jobTitle ? (
                <p className="sm:col-span-2">
                  Позиция · <span className="font-medium text-slate-700">{jobTitle}</span>
                </p>
              ) : null}
              <p>
                ID интервью · <span className="font-medium text-slate-700">{jobAiId ?? "—"}</span>
              </p>
              <p>
                Дата и время · <span className="font-medium text-slate-700">{meetingAtAbsolute}</span>
              </p>
            </div>
          )}

          {candidateMode ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-300/40 pt-4">
              <InterviewStatusBadge status={status} />
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-t border-slate-300/40 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <InterviewStatusBadge status={status} />
                {/*
                  CTA hierarchy: в активной фазе главная кнопка — Завершить
                  (filled red), Запустить уходит в outline-disabled. В idle —
                  наоборот. Оператор глазами видит ровно одно primary-действие.
                 */}
                {/*
                  HR-сторона БОЛЬШЕ НЕ инициирует AI-сессию.
                  Интервью стартует только когда кандидат переходит по своей
                  уникальной ссылке (candidate-flow). HR-dashboard — это
                  исключительно surface наблюдения и управления завершением.
                  См. use-interview-session.start()::CANDIDATE_INITIATED_TRIGGERS.
                 */}
                {interviewActive ? (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                      Кандидат на связи
                    </span>
                    {onStopSession ? (
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={onStopSession}
                        disabled={stopSessionDisabled}
                        title={stopSessionDisabled ? "Завершение временно недоступно" : "Завершить текущее интервью"}
                        className="ml-auto h-9 shrink-0 rounded-lg px-4 text-xs font-semibold"
                      >
                        Завершить интервью
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
                      <span className="size-1.5 rounded-full bg-slate-400" aria-hidden />
                      Ожидаем подключения кандидата по ссылке
                    </span>
                    {onStopSession ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={onStopSession}
                        disabled
                        title="Доступно после подключения кандидата"
                        className="ml-auto h-9 shrink-0 rounded-lg px-4 text-xs text-slate-500"
                      >
                        Завершить интервью
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
              {showDebugActions && onFail ? (
                <Button
                  onClick={onFail}
                  disabled={failDisabled}
                  variant="ghost"
                  className="h-8 w-full self-start rounded-md px-3 text-[11px] text-slate-500 hover:text-rose-700 sm:w-auto"
                >
                  Прервать с ошибкой
                </Button>
              ) : null}
            </div>
          )}

          {candidateMode ? null : (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger className="inline-flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-auto">
                Технические детали
                <ChevronDown className={`size-4 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid grid-cols-1 gap-x-10 gap-y-2 text-slate-500 sm:grid-cols-2">
                  <p>
                    Внутренний идентификатор ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{meetingId ?? "Появится после запуска"}</span>
                  </p>
                  <p>
                    ID реалтайм-сессии ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{sessionId ?? "Появится после запуска"}</span>
                  </p>
                  {showDebugActions && rawStatusLabel ? (
                    <p className="sm:col-span-2">
                      Внутренняя фаза · <span className="font-mono text-[11px] text-slate-700">{rawStatusLabel}</span>
                    </p>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>
    </header>
  );
}
