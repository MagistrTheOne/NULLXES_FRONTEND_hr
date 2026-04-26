"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { ObserverStreamCard, type ObserverConnectionStatus } from "@/components/interview/observer-stream-card";
import { InterviewStatusBadge } from "@/components/interview/interview-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  getInterviewById,
  getRuntimeSnapshotByInterview,
  isApiRequestError,
  listMeetingsSnapshot,
  type InterviewDetail,
  type MeetingListItem,
  type RuntimeSnapshot
} from "@/lib/api";
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
const ACTIVE_MEETING_STATUSES = new Set(["starting", "in_meeting"]);

function pickActiveMeetingForInterview(jobAiId: number, meetings: MeetingListItem[]): string | null {
  const matched = meetings
    .filter((meeting) => {
      if (!ACTIVE_MEETING_STATUSES.has(String(meeting.status ?? ""))) {
        return false;
      }
      const raw = (meeting.metadata ?? {}).jobAiInterviewId;
      return Number(raw) === jobAiId;
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return matched[0]?.meetingId ?? null;
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSpectatorLoadError(error: unknown): { userMessage: string; technical: string } {
  const fallback = "Не удалось загрузить собеседование";
  const raw = error instanceof Error ? error.message : String(error ?? fallback);
  const stripped = stripHtmlTags(raw);
  const normalized = stripped.length > 0 ? stripped : fallback;
  if (isApiRequestError(error)) {
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return {
        userMessage:
          "Gateway временно недоступен. Блокер для observer: не удаётся получить meetingId для этой сессии. Обновите страницу через 10-20 секунд.",
        technical: `gateway_${error.status}: ${normalized}`
      };
    }
    return {
      userMessage: normalized,
      technical: `api_${error.status ?? "unknown"}: ${normalized}`
    };
  }
  return { userMessage: normalized, technical: normalized };
}

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
  const spectatorJoinToken = useMemo(() => {
    const raw = searchParams.get("joinToken");
    const t = typeof raw === "string" ? raw.trim() : "";
    return t.length > 0 ? t : null;
  }, [searchParams]);
  const spectatorObserverTicket = useMemo(() => {
    const raw = searchParams.get("observerTicket");
    const t = typeof raw === "string" ? raw.trim() : "";
    return t.length > 0 ? t : null;
  }, [searchParams]);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observerControl, setObserverControl] = useState<ObserverControlState>(DEFAULT_OBSERVER_CONTROL);
  const [observerStatus, setObserverStatus] = useState<ObserverConnectionStatus>("waiting_meeting");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [activeMeetingIdFallback, setActiveMeetingIdFallback] = useState<string | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot | null>(null);

  useEffect(() => {
    if (!jobAiId) {
      setDetail(null);
      setError("Некорректный jobAiId");
      setTechnicalError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (!cancelled) {
        setLoading(true);
      }
      try {
        const [next, meetingsSnapshot, fetchedRuntimeSnapshot] = await Promise.all([
          getInterviewById(jobAiId, true),
          listMeetingsSnapshot().catch(() => null),
          getRuntimeSnapshotByInterview(jobAiId).catch(() => null)
        ]);
        const projectedMeetingId = next?.projection?.nullxesMeetingId ?? null;
        const runtimeMeetingId = fetchedRuntimeSnapshot?.meetingId ?? null;
        const fallbackMeetingId =
          meetingsSnapshot && Array.isArray(meetingsSnapshot.meetings)
            ? pickActiveMeetingForInterview(jobAiId, meetingsSnapshot.meetings)
            : null;
        const authoritativeFallback =
          runtimeMeetingId && runtimeMeetingId !== projectedMeetingId
            ? runtimeMeetingId
            : runtimeMeetingId
              ? null
              : projectedMeetingId && fallbackMeetingId && projectedMeetingId !== fallbackMeetingId
                ? fallbackMeetingId
                : projectedMeetingId
                  ? null
                  : fallbackMeetingId;
        if (!cancelled) {
          setDetail(next);
          setRuntimeSnapshot(fetchedRuntimeSnapshot);
          setActiveMeetingIdFallback(authoritativeFallback);
          setError(null);
          setTechnicalError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const normalized = normalizeSpectatorLoadError(err);
          setError(normalized.userMessage);
          setTechnicalError(normalized.technical);
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
    }, 8000);

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
  const effectiveMeetingId = activeMeetingIdFallback ?? meetingId;
  const candidateName = [detail?.projection.candidateFirstName, detail?.projection.candidateLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const companyName = detail?.projection.companyName ?? "";
  const canConnect = Boolean(effectiveMeetingId);

  const sseAttemptRef = useRef(0);

  useEffect(() => {
    if (!effectiveMeetingId) {
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const url = `/api/gateway/runtime/${encodeURIComponent(effectiveMeetingId)}/stream`;

    const connect = () => {
      if (cancelled) {
        return;
      }
      source?.close();
      const es = new EventSource(url);
      source = es;
      es.addEventListener("open", () => {
        sseAttemptRef.current = 0;
      });
      es.addEventListener("snapshot", (event) => {
        try {
          const snapshot = JSON.parse((event as MessageEvent).data) as RuntimeSnapshot;
          setRuntimeSnapshot(snapshot);
          if (snapshot.meetingId !== meetingId) {
            setActiveMeetingIdFallback(snapshot.meetingId);
          }
        } catch {
          // Ignore malformed SSE frames; polling fallback still runs.
        }
      });
      es.onerror = () => {
        es.close();
        if (cancelled) {
          return;
        }
        sseAttemptRef.current += 1;
        const exp = Math.min(sseAttemptRef.current - 1, 5);
        const delayMs = Math.min(30_000, 1000 * 2 ** exp);
        reconnectTimer = setTimeout(connect, delayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [effectiveMeetingId, meetingId]);

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
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (typeof window === "undefined") return;
                  const url = new URL(window.location.href);
                  url.searchParams.set("popout", "1");
                  window.open(url.toString(), "_blank", "noopener,noreferrer,width=1520,height=980");
                }}
              >
                Открыть в отдельном окне
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
                    <span className="font-mono text-[11px] text-slate-700">{effectiveMeetingId ?? "Появится после запуска"}</span>
                  </p>
                  <p>
                    Видеопоток ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{videoStatus.label}</span>
                  </p>
                  <p>
                    Runtime revision ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">{runtimeSnapshot?.revision ?? "—"}</span>
                  </p>
                  <p>
                    Runtime health ·{" "}
                    <span className="font-mono text-[11px] text-slate-700">
                      {runtimeSnapshot?.health.ready ? "ready" : runtimeSnapshot ? runtimeSnapshot.health.warnings.join(",") || "not_ready" : "—"}
                    </span>
                  </p>
                  {SHOW_INTERNAL_DEBUG_UI ? (
                    <p className="sm:col-span-2">
                      jobAiStatus · <span className="font-mono text-[11px] text-slate-700">{detail?.projection.jobAiStatus ?? "—"}</span>
                    </p>
                  ) : null}
                  {technicalError ? (
                    <p className="sm:col-span-2">
                      gateway diagnostic ·{" "}
                      <span className="font-mono text-[11px] text-slate-700 break-all">{technicalError}</span>
                    </p>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>

        {/* === Session canvas (matches target: see session + own camera) === */}
        <main className="grid grid-cols-1 gap-8">
          <div className="flex min-h-0 min-w-0 flex-col">
            <ObserverStreamCard
              title="Сессия (режим наблюдения)"
              participantName={candidateName || "Наблюдатель"}
              meetingId={effectiveMeetingId}
              enabled={canConnect}
              visible
              talkMode={observerControl.talk}
              mutePlayback={false}
              allowVisibilityToggle={false}
              allowTalkToggle={false}
              sessionMirrorLayout
              showSelfPreview
              spectatorJoinToken={spectatorJoinToken}
              spectatorObserverTicket={spectatorObserverTicket}
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
        </main>

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
