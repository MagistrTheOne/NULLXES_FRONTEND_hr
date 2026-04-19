"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { ObserverStreamCard, type ObserverConnectionStatus } from "@/components/interview/observer-stream-card";
import { InterviewStatusBadge } from "@/components/interview/interview-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getInterviewById, getMeetingDetail, isApiRequestError, type InterviewDetail } from "@/lib/api";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { InterviewSummaryDisplay } from "@/components/interview/interview-summary-display";
import {
  mapProjectionToInterviewStatus,
  mapVideoStatus,
  type VideoConnectionState
} from "@/lib/interview-status";
import {
  getObserverControlState,
  resolveObserverTalkState,
  setObserverControlState,
  subscribeObserverControlState,
  type ObserverControlState
} from "@/lib/observer-control";

const DEFAULT_OBSERVER_CONTROL: ObserverControlState = {
  visibility: "visible",
  talk: "off",
  updatedAt: ""
};

const SHOW_INTERNAL_DEBUG_UI = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";

/**
 * Маппинг ObserverConnectionStatus (внутренний enum карточки) в публичный
 * VideoConnectionState. Дублирует логику внутри ObserverStreamCard, чтобы
 * spectator-page показывал consistent статус, не привязываясь к internal API
 * карточки. Если карточка изменит свой enum — поменяем тут.
 */
function mapObserverStatusToVideoState(status: ObserverConnectionStatus): VideoConnectionState {
  switch (status) {
    case "joining":
      return "connecting";
    case "joined":
      return "connected";
    case "no_participants":
      return "no_participants";
    case "error":
      return "failed";
    case "idle_hidden":
      return "hidden";
    case "waiting_meeting":
    default:
      return "idle";
  }
}

function SpectatorBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawJobAiId = searchParams.get("jobAiId");
  const jobAiId = useMemo(() => {
    if (!rawJobAiId) return null;
    const parsed = Number(rawJobAiId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [rawJobAiId]);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observerControl, setObserverControl] = useState<ObserverControlState>(DEFAULT_OBSERVER_CONTROL);
  const [observerStatus, setObserverStatus] = useState<ObserverConnectionStatus>("waiting_meeting");
  const [meetingSummary, setMeetingSummary] = useState<InterviewSummaryPayload | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!jobAiId) {
      setDetail(null);
      setError("Некорректный jobAiId");
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (!cancelled) {
        setLoading(true);
      }
      try {
        const next = await getInterviewById(jobAiId, true);
        if (!cancelled) {
          setDetail(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Не удалось загрузить собеседование");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobAiId]);

  useEffect(() => {
    if (!jobAiId) {
      setObserverControl(DEFAULT_OBSERVER_CONTROL);
      return;
    }
    const persisted = getObserverControlState(jobAiId);
    setObserverControl({
      visibility: "visible",
      talk: persisted.talk,
      updatedAt: persisted.updatedAt
    });
    return subscribeObserverControlState(jobAiId, (next) => {
      setObserverControl({
        visibility: "visible",
        talk: next.talk,
        updatedAt: next.updatedAt
      });
    });
  }, [jobAiId]);

  const meetingId = detail?.projection.nullxesMeetingId ?? null;
  const candidateName = [detail?.projection.candidateFirstName, detail?.projection.candidateLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const companyName = detail?.projection.companyName ?? "";
  const canConnect = Boolean(meetingId);

  // Глобальный статус интервью (унифицирован с HR mapPhaseToStatus).
  const interviewStatus = useMemo(
    () => mapProjectionToInterviewStatus(detail?.projection.nullxesStatus),
    [detail?.projection.nullxesStatus]
  );
  // Локальный статус видео-канала спектатора.
  const videoStatus = useMemo(
    () => mapVideoStatus(mapObserverStatusToVideoState(observerStatus)),
    [observerStatus]
  );

  useEffect(() => {
    if (!meetingId || detail?.projection.nullxesStatus !== "completed") {
      setMeetingSummary(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const loadSummary = async () => {
      try {
        const res = await getMeetingDetail(meetingId);
        const raw = res.meeting?.metadata?.interviewSummary;
        if (!cancelled && raw && typeof raw === "object") {
          setMeetingSummary(raw as InterviewSummaryPayload);
        }
      } catch (err) {
        if (cancelled) return;
        if (isApiRequestError(err) && err.status === 404) {
          setMeetingSummary(null);
          stopPolling();
          return;
        }
        setMeetingSummary(null);
      }
    };
    void loadSummary();
    timer = setInterval(() => {
      void loadSummary();
    }, 8000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [detail?.projection.nullxesStatus, meetingId]);

  return (
    <div className="min-h-screen bg-[#dfe4ec] px-4 py-6 sm:px-6 sm:py-8 md:px-10">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6">
        {/* === Header card: глобальный статус интервью + контекст === */}
        <Card className="rounded-2xl border-0 bg-[#d9dee7] shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-700">Наблюдение за интервью</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm text-slate-700">
            {/* Status — first and most prominent */}
            <div className="flex flex-wrap items-center gap-3">
              <InterviewStatusBadge status={interviewStatus} />
              <span className="text-xs text-slate-500">{loading ? "Обновление…" : "Статус интервью"}</span>
            </div>

            {/* Context: кандидат + компания */}
            <div className="grid grid-cols-1 gap-2 text-slate-500 sm:grid-cols-2">
              <p>
                Кандидат · <span className="font-medium text-slate-700">{candidateName || "—"}</span>
              </p>
              <p>
                Компания · <span className="font-medium text-slate-700">{companyName || "—"}</span>
              </p>
              {jobAiId ? (
                <p>
                  ID интервью · <span className="font-medium text-slate-700">{jobAiId}</span>
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="rounded-lg bg-rose-100 px-3 py-2 text-rose-700">{error}</p>
            ) : null}
            {!canConnect ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                Интервью ещё не запущено. Видео подключится автоматически после старта.
              </p>
            ) : null}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  if (jobAiId) {
                    void getInterviewById(jobAiId, true).then(setDetail).catch(() => undefined);
                  }
                }}
              >
                Обновить
              </Button>
              <Button
                type="button"
                onClick={() => {
                  router.push(jobAiId ? `/?jobAiId=${encodeURIComponent(jobAiId)}` : "/");
                }}
              >
                Открыть HR-панель
              </Button>
            </div>

            {/* Tech details — collapsed by default, hidden внутренние ID */}
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger className="inline-flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:w-auto">
                Технические детали
                <ChevronDown className={`size-4 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid grid-cols-1 gap-x-10 gap-y-2 text-xs text-slate-500 sm:grid-cols-2">
                  <p>
                    Внутренний идентификатор ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{meetingId ?? "Появится после запуска"}</span>
                  </p>
                  <p>
                    Видеопоток ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{videoStatus.label}</span>
                  </p>
                  {SHOW_INTERNAL_DEBUG_UI ? (
                    <p className="sm:col-span-2">
                      jobAiStatus · <span className="font-mono text-[11px] text-slate-700">{detail?.projection.jobAiStatus ?? "—"}</span>
                    </p>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>

        {/* === Video card === */}
        <ObserverStreamCard
          title="Видео интервью"
          participantName="Наблюдатель"
          meetingId={meetingId}
          enabled={canConnect}
          visible
          talkMode={observerControl.talk}
          mutePlayback={false}
          allowVisibilityToggle={false}
          allowTalkToggle
          onTalkModeChange={(nextTalkMode) => {
            if (!jobAiId) {
              return;
            }
            const next = resolveObserverTalkState(observerControl, nextTalkMode);
            setObserverControlState(jobAiId, {
              visibility: "visible",
              talk: next.talk,
              updatedAt: new Date().toISOString()
            });
          }}
          onStatusChange={setObserverStatus}
        />

        {/* === Summary === */}
        <InterviewSummaryDisplay summary={meetingSummary} title="Итог интервью" />
      </div>
    </div>
  );
}

export default function SpectatorPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#dfe4ec] text-slate-600">Загрузка…</div>}>
      <SpectatorBody />
    </Suspense>
  );
}
