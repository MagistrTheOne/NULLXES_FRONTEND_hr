"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ObserverStreamCard, type ObserverConnectionStatus } from "@/components/interview/observer-stream-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getInterviewById, getMeetingDetail, type InterviewDetail } from "@/lib/api";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { InterviewSummaryDisplay } from "@/components/interview/interview-summary-display";
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

function observerStatusLabel(status: ObserverConnectionStatus): string {
  if (status === "joining") return "observer: подключение";
  if (status === "joined") return "observer: подключен";
  if (status === "no_participants") return "observer: подключен, ожидаем участников";
  if (status === "error") return "observer: ошибка подключения";
  if (status === "idle_hidden") return "observer: скрыт";
  return "observer: ожидание meeting";
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
  const candidateName = [detail?.projection.candidateFirstName, detail?.projection.candidateLastName].filter(Boolean).join(" ").trim();
  const canConnect = Boolean(meetingId);

  useEffect(() => {
    if (!meetingId || detail?.projection.nullxesStatus !== "completed") {
      setMeetingSummary(null);
      return;
    }
    let cancelled = false;
    const loadSummary = async () => {
      try {
        const res = await getMeetingDetail(meetingId);
        const raw = res.meeting?.metadata?.interviewSummary;
        if (!cancelled && raw && typeof raw === "object") {
          setMeetingSummary(raw as InterviewSummaryPayload);
        }
      } catch {
        if (!cancelled) {
          setMeetingSummary(null);
        }
      }
    };
    void loadSummary();
    const timer = setInterval(() => {
      void loadSummary();
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detail?.projection.nullxesStatus, meetingId]);

  return (
    <div className="min-h-screen bg-[#dfe4ec] px-4 py-6 sm:px-6 sm:py-8 md:px-10">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6">
        <Card className="rounded-2xl border-0 bg-[#d9dee7] shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-slate-700">Режим наблюдателя</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-slate-700">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <p>JobAI ID: {jobAiId ?? "—"}</p>
              <p>Кандидат: {candidateName || "—"}</p>
              <p>NULLXES ID: {meetingId ?? "ожидание запуска"}</p>
              <p>
                Статус:{" "}
                {loading
                  ? "обновление..."
                  : `${detail?.projection.nullxesBusinessLabel ?? "—"} · ${observerStatusLabel(observerStatus)}`}
              </p>
            </div>
            {error ? <p className="rounded-lg bg-rose-100 px-3 py-2 text-rose-700">{error}</p> : null}
            {!canConnect ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                Сессия еще не запущена. Observer подключится автоматически после старта интервью.
              </p>
            ) : null}
            <InterviewSummaryDisplay summary={meetingSummary} title="Итог для наблюдателя" />
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
                Вернуться к интервью кандидата
              </Button>
            </div>
          </CardContent>
        </Card>
        <ObserverStreamCard
          title="Observer: кандидат + HR + вы"
          participantName="Observer"
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
