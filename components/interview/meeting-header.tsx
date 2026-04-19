import { useEffect, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { extractJobAiIdFromEntryUrl } from "@/lib/candidate-entry-url";

type MeetingHeaderProps = {
  statusLabel: string;
  meetingId: string | null;
  sessionId: string | null;
  jobAiId?: number;
  companyName?: string;
  meetingAt?: string;
  prototypeEntryUrl?: string;
  onEntryUrlCommit?: (value: string) => void;
  candidateFio: string;
  onStart: () => void;
  /** Полное завершение сессии (закрытие meeting, статус completed). */
  onStopSession?: () => void;
  stopSessionDisabled?: boolean;
  onFail?: () => void;
  startDisabled?: boolean;
  failDisabled?: boolean;
  showDebugActions?: boolean;
  /**
   * Если true — мы рендерим UI для кандидата (URL входа, служебные ID, кнопки
   * запуска интервью и Stop session не показываются — это HR-only элементы).
   */
  candidateMode?: boolean;
};

export function MeetingHeader({
  statusLabel,
  meetingId,
  sessionId,
  jobAiId,
  companyName,
  meetingAt,
  prototypeEntryUrl,
  onEntryUrlCommit,
  candidateFio,
  onStart,
  onStopSession,
  stopSessionDisabled = true,
  onFail,
  startDisabled = false,
  failDisabled = true,
  showDebugActions = false,
  candidateMode = false
}: MeetingHeaderProps) {
  const [entryUrlInput, setEntryUrlInput] = useState(prototypeEntryUrl ?? "");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const missingRuntimeIdLabel = jobAiId ? "будет после Start Session" : "—";

  useEffect(() => {
    queueMicrotask(() => {
      setEntryUrlInput(prototypeEntryUrl ?? "");
    });
  }, [prototypeEntryUrl]);

  const canonicalUrl = (prototypeEntryUrl ?? "").trim();
  const hasCopySource = Boolean(canonicalUrl || entryUrlInput.trim());

  return (
    <header className="flex w-full min-w-0 flex-col items-center gap-8 md:gap-10">
      <div className="flex w-full justify-center pt-1">
        <h1 className="text-center text-4xl font-black tracking-tight text-[#0f1114] sm:text-5xl md:text-6xl">
          JOB <span className="rounded-xl bg-sky-500 px-3 py-1 text-white">AI</span>
        </h1>
      </div>

      {candidateMode ? null : (
        <div className="w-full max-w-xl space-y-2 px-0 sm:px-1">
          <p className="text-center text-xs leading-relaxed text-slate-500 sm:text-left">
            Ссылка кандидата готова после выбора интервью.
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
              placeholder="Ссылка на интерфейс кандидата"
              className="min-h-12 flex-1 rounded-lg border border-transparent bg-white/70 py-3 text-base leading-normal text-slate-800 shadow-none placeholder:text-slate-400 focus-visible:ring-1 focus-visible:ring-slate-300/60"
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              disabled={!hasCopySource}
              className="h-12 w-12 shrink-0 rounded-lg border border-slate-300/50 bg-white/80 text-slate-600 shadow-sm disabled:opacity-40"
              title={hasCopySource ? "Копировать ссылку" : "Ссылка появится после выбора собеседования"}
              onClick={() => {
                const text = (canonicalUrl || entryUrlInput.trim()).trim();
                if (!text) {
                  return;
                }
                setEntryUrlInput(text);
                void navigator.clipboard.writeText(text);
                if (!extractJobAiIdFromEntryUrl(text)) {
                  toast.error("В ссылке нет jobAiId", {
                    description: "Скопируйте ссылку из таблицы после выбора интервью или вставьте корректный URL."
                  });
                  return;
                }
                onEntryUrlCommit?.(text);
                toast.success("Скопировано и проверено", {
                  description: "Поле обновлено, адресная строка синхронизирована с jobAiId из ссылки."
                });
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <Card className="w-full max-w-xl min-w-0 rounded-2xl border-0 bg-[#d9dee7] shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
        <CardHeader className="space-y-1 pb-3">
          <CardTitle className="text-base font-semibold text-slate-600">Видеособеседование</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-slate-600">
          <div className="grid grid-cols-1 gap-2 text-slate-500 sm:grid-cols-2">
            <p>
              Кандидат: <span className="font-medium text-slate-700">{candidateFio || "—"}</span>
            </p>
            <p>
              Компания: <span className="font-medium text-slate-700">{companyName ?? "—"}</span>
            </p>
            {candidateMode ? null : (
              <p>
                JobAI ID: <span className="font-medium text-slate-700">{jobAiId ?? "—"}</span>
              </p>
            )}
            {candidateMode && meetingAt ? (
              <p>
                Дата и время: <span className="font-medium text-slate-700">{new Date(meetingAt).toLocaleString("ru-RU")}</span>
              </p>
            ) : null}
          </div>

          {candidateMode ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-300/40 pt-4">
              <Badge className="shrink-0 bg-[#8aa0bb] text-white">{statusLabel}</Badge>
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-t border-slate-300/40 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="shrink-0 bg-[#8aa0bb] text-white">{statusLabel}</Badge>
                <Button
                  onClick={onStart}
                  disabled={startDisabled}
                  className="h-9 w-full shrink-0 rounded-lg bg-[#3a8edb] px-4 text-xs text-white hover:bg-[#2f7bc0] sm:w-auto"
                >
                  Начать собеседование
                </Button>
              </div>
              {onStopSession ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={onStopSession}
                  disabled={stopSessionDisabled}
                  className="h-11 w-full shrink-0 rounded-xl px-4 text-sm font-semibold shadow-sm sm:h-12"
                >
                  Стоп сессия
                </Button>
              ) : null}
              {showDebugActions && onFail ? (
                <>
                  <Button
                    onClick={onFail}
                    disabled={failDisabled}
                    variant="secondary"
                    className="h-9 w-full shrink-0 rounded-lg px-4 text-xs sm:w-auto"
                  >
                    Fail Interview
                  </Button>
                </>
              ) : null}
            </div>
          )}

          {candidateMode ? null : (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger
                className="inline-flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-auto"
              >
                  Подробнее о сессии
                  <ChevronDown className={`size-4 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid grid-cols-1 gap-x-10 gap-y-2 text-slate-500 sm:grid-cols-2">
                  <p>NULLXES ID: {meetingId ?? missingRuntimeIdLabel}</p>
                  <p>Дата проведения: {meetingAt ? new Date(meetingAt).toLocaleString("ru-RU") : "—"}</p>
                  <p className="break-all sm:col-span-2">Session ID: {sessionId ?? missingRuntimeIdLabel}</p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>
    </header>
  );
}
