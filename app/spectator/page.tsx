"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import {
  ObserverStreamCard,
  type ObserverAccessMode,
  type ObserverConnectionStatus
} from "@/components/interview/observer-stream-card";
import { InterviewStatusBadge } from "@/components/interview/interview-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  subscribeObserverControlState,
  type ObserverControlState
} from "@/lib/observer-control";

const DEFAULT_OBSERVER_CONTROL: ObserverControlState = {
  visibility: "visible",
  talk: "off",
  updatedAt: ""
};

/** Meeting considered active for spectator join (projection vs runtime wording may differ). */
const ACTIVE_MEETING_STATUSES = new Set(["starting", "in_meeting", "active", "live", "meeting_in_progress"]);
const TERMINAL_MEETING_STATUSES = new Set(["completed", "stopped_during_meeting"]);
const SPECTATOR_SSE_MAX_RETRIES = 5;
const SPECTATOR_SSE_SLOW_RETRY_MS = 45_000;

type MeetingSource = "none" | "projection" | "meetings_snapshot" | "runtime_snapshot" | "sse_snapshot";
type MeetingResolution = {
  id: string | null;
  source: MeetingSource;
  updatedAt: number;
};
const MEETING_SOURCE_PRIORITY: Record<MeetingSource, number> = {
  none: 0,
  meetings_snapshot: 1,
  projection: 2,
  sse_snapshot: 3,
  runtime_snapshot: 4
};

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

function normalizeMeetingId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  const signedSpectator = useMemo(() => searchParams.get("signed") === "1", [searchParams]);
  const spectatorJoinToken = useMemo(() => {
    const raw = searchParams.get("joinToken");
    const t = typeof raw === "string" ? raw.trim() : "";
    return signedSpectator && t.length > 0 ? t : null;
  }, [searchParams, signedSpectator]);
  const spectatorObserverTicketFromQuery = useMemo(() => {
    const raw = searchParams.get("observerTicket");
    const t = typeof raw === "string" ? raw.trim() : "";
    return signedSpectator && t.length > 0 ? t : null;
  }, [searchParams, signedSpectator]);
  const spectatorViewerKey = useMemo(() => {
    const raw = searchParams.get("viewerKey");
    const t = typeof raw === "string" ? raw.trim() : "";
    return signedSpectator && t.length > 0 ? t : null;
  }, [searchParams, signedSpectator]);
  const [spectatorObserverTicket, setSpectatorObserverTicket] = useState<string | null>(null);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observerControl, setObserverControl] = useState<ObserverControlState>(DEFAULT_OBSERVER_CONTROL);
  const [observerStatus, setObserverStatus] = useState<ObserverConnectionStatus>("waiting_meeting");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  void detailsOpen;
  void setDetailsOpen;
  void technicalError;
  void setTechnicalError;
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [meetingResolution, setMeetingResolution] = useState<MeetingResolution>({
    id: null,
    source: "none",
    updatedAt: 0
  });
  const loadSeqRef = useRef(0);

  const applyMeetingCandidate = useMemo(
    () =>
      (source: MeetingSource, rawId: unknown) => {
        const candidateId = normalizeMeetingId(rawId);
        if (!candidateId) {
          return;
        }
        setMeetingResolution((prev) => {
          if (!prev.id) {
            return { id: candidateId, source, updatedAt: Date.now() };
          }
          if (prev.id === candidateId) {
            return prev.source === source ? prev : { ...prev, source };
          }
          const nextPriority = MEETING_SOURCE_PRIORITY[source];
          const prevPriority = MEETING_SOURCE_PRIORITY[prev.source];
          if (nextPriority < prevPriority) {
            return prev;
          }
          return { id: candidateId, source, updatedAt: Date.now() };
        });
      },
    []
  );

  useEffect(() => {
    if (!jobAiId) {
      setDetail(null);
      setError("Некорректный jobAiId");
      setTechnicalError(null);
      setMeetingResolution({ id: null, source: "none", updatedAt: Date.now() });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const seq = ++loadSeqRef.current;
      if (!cancelled) {
        setLoading(true);
      }
      try {
        const [next, meetingsSnapshot, fetchedRuntimeSnapshot] = await Promise.all([
          getInterviewById(jobAiId, true),
          listMeetingsSnapshot().catch(() => null),
          getRuntimeSnapshotByInterview(jobAiId).catch(() => null)
        ]);
        if (cancelled || seq !== loadSeqRef.current) {
          return;
        }
        const projectionStatus = String(next?.projection?.nullxesStatus ?? "");
        const projectedMeetingId =
          ACTIVE_MEETING_STATUSES.has(projectionStatus)
            ? normalizeMeetingId(next?.projection?.nullxesMeetingId)
            : null;
        const runtimeMeetingId = normalizeMeetingId(fetchedRuntimeSnapshot?.meetingId);
        const fallbackMeetingId =
          meetingsSnapshot && Array.isArray(meetingsSnapshot.meetings)
            ? pickActiveMeetingForInterview(jobAiId, meetingsSnapshot.meetings)
            : null;
        applyMeetingCandidate("projection", projectedMeetingId);
        applyMeetingCandidate("meetings_snapshot", fallbackMeetingId);
        applyMeetingCandidate("runtime_snapshot", runtimeMeetingId);
        setDetail(next);
        setRuntimeSnapshot(fetchedRuntimeSnapshot);
        setError(null);
        setTechnicalError(null);
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

    let nextPollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollLoop = async () => {
      if (cancelled) {
        return;
      }
      await load();
      if (cancelled) {
        return;
      }
      nextPollTimer = setTimeout(() => {
        void pollLoop();
      }, 8000);
    };
    void pollLoop();

    return () => {
      cancelled = true;
      if (nextPollTimer) {
        clearTimeout(nextPollTimer);
      }
    };
  }, [applyMeetingCandidate, jobAiId]);

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

  const effectiveMeetingId = meetingResolution.id;
  // External signed spectator mode is primarily identified by joinToken.
  // observerTicket is short-lived/consume-once and may be missing on initial redirect or after refresh.
  const observerAccessMode: ObserverAccessMode = spectatorJoinToken ? "external_signed" : "internal_dashboard";
  const isSignedSpectator = observerAccessMode === "external_signed";
  const candidateName = [detail?.projection.candidateFirstName, detail?.projection.candidateLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const companyName = detail?.projection.companyName ?? "";
  const terminalByProjection =
    TERMINAL_MEETING_STATUSES.has(String(detail?.projection.nullxesStatus ?? "")) ||
    TERMINAL_MEETING_STATUSES.has(String(detail?.projection.jobAiStatus ?? ""));
  const projectionStatus = String(detail?.projection.nullxesStatus ?? "");
  const projectionActive = ACTIVE_MEETING_STATUSES.has(projectionStatus);
  const runtimeMeetingId = normalizeMeetingId(runtimeSnapshot?.meetingId);
  const runtimeMatchesMeeting = Boolean(effectiveMeetingId && runtimeMeetingId === effectiveMeetingId);
  const terminalByRuntime =
    runtimeMatchesMeeting && TERMINAL_MEETING_STATUSES.has(String(runtimeSnapshot?.meeting.status ?? ""));
  // Prefer runtime when it matches current meeting to avoid projection lag blocking observer join.
  const sessionTerminal = terminalByRuntime || (!runtimeMatchesMeeting && terminalByProjection);
  const runtimeActive =
    runtimeMatchesMeeting && ACTIVE_MEETING_STATUSES.has(String(runtimeSnapshot?.meeting.status ?? ""));
  const runtimeHealthReady = runtimeMatchesMeeting && runtimeSnapshot?.health.ready === true;
  void runtimeHealthReady;
  const runtimeStreamCallIdRaw =
    typeof runtimeSnapshot?.media?.streamCallId === "string" ? runtimeSnapshot.media.streamCallId.trim() : "";
  const runtimeStreamCallTypeRaw =
    typeof runtimeSnapshot?.media?.streamCallType === "string" ? runtimeSnapshot.media.streamCallType.trim() : "";
  const resolvedStreamCallId = runtimeMatchesMeeting ? runtimeStreamCallIdRaw : "";
  const resolvedStreamCallType = runtimeMatchesMeeting ? runtimeStreamCallTypeRaw || "default" : "";
  const hasTrustedStreamBinding = Boolean(resolvedStreamCallId) && Boolean(resolvedStreamCallType);
  const accessReady =
    observerAccessMode === "internal_dashboard"
      ? Boolean(effectiveMeetingId) && hasTrustedStreamBinding
      : Boolean(spectatorJoinToken) && Boolean(spectatorObserverTicket) && Boolean(effectiveMeetingId) && hasTrustedStreamBinding;
  // Spectator joins when we have a trusted meeting + trusted Stream binding (health.ready is best-effort only).
  const canConnect = accessReady && runtimeMatchesMeeting && !sessionTerminal;
  const spectatorWaitingReason = useMemo(() => {
    if (sessionTerminal) {
      return null;
    }
    if (!effectiveMeetingId) {
      return "Ожидаем назначение meetingId от runtime. Интервью ещё не перешло в активную фазу.";
    }
    if (!runtimeSnapshot) {
      return "Сессия активируется, ждём runtime snapshot.";
    }
    if (!runtimeMatchesMeeting) {
      return "Runtime обновляется, ждём подтверждение актуальной сессии наблюдения.";
    }
    if (isSignedSpectator && !spectatorObserverTicket) {
      return "Подготавливаем доступ наблюдателя…";
    }
    if (!hasTrustedStreamBinding) {
      return "Сессия активна. Ждём конфигурацию Stream call.";
    }
    if (!projectionActive && !runtimeActive) {
      // Binding exists; allow connect even if status signal lags.
      return "Подключаем наблюдателя…";
    }
    return null;
  }, [
    effectiveMeetingId,
    hasTrustedStreamBinding,
    isSignedSpectator,
    projectionActive,
    runtimeActive,
    runtimeMatchesMeeting,
    runtimeSnapshot,
    spectatorObserverTicket,
    sessionTerminal
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!jobAiId) return;
    if (!spectatorJoinToken) {
      // Internal observer dashboard must not reuse external signed spectator credentials.
      setSpectatorObserverTicket(null);
      return;
    }
    // Load persisted spectator credentials (joinToken is always from URL).
    const storageKey = `nullxes:spectator:credentials:${jobAiId}`;
    const fromStorage = (() => {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (!raw) return null;
        return JSON.parse(raw) as { observerTicket?: string; viewerKey?: string };
      } catch {
        return null;
      }
    })();
    const queryTicket = spectatorObserverTicketFromQuery?.trim() || "";
    const storedTicket = typeof fromStorage?.observerTicket === "string" ? fromStorage.observerTicket.trim() : "";
    const effective = queryTicket || storedTicket || null;
    setSpectatorObserverTicket(effective);
  }, [jobAiId, spectatorJoinToken, spectatorObserverTicketFromQuery]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!jobAiId || !spectatorJoinToken) return;
    const storageKey = `nullxes:spectator:credentials:${jobAiId}`;
    // Persist observerTicket if we have it (do not persist joinToken — it stays in the URL).
    const ticket = spectatorObserverTicket?.trim() || "";
    if (!ticket) return;
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({ observerTicket: ticket, viewerKey: spectatorViewerKey ?? undefined }));
    } catch {
      /* noop */
    }
  }, [jobAiId, spectatorJoinToken, spectatorObserverTicket, spectatorViewerKey]);

  useEffect(() => {
    if (!spectatorJoinToken) return;
    if (spectatorObserverTicket) return;
    // External spectator without ticket: fetch a fresh one from gateway.
    let cancelled = false;
    const run = async () => {
      const res = await fetch(`/api/gateway/join/spectator/${encodeURIComponent(spectatorJoinToken)}/session-ticket`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" }
      }).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as { observerTicket?: unknown };
      const ticket = typeof payload.observerTicket === "string" ? payload.observerTicket.trim() : "";
      if (ticket) {
        setSpectatorObserverTicket(ticket);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [spectatorJoinToken, spectatorObserverTicket]);

  const sseAttemptRef = useRef(0);
  const sseSlowModeRef = useRef(false);

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
        sseSlowModeRef.current = false;
      });
      es.addEventListener("snapshot", (event) => {
        try {
          const snapshot = JSON.parse((event as MessageEvent).data) as RuntimeSnapshot;
          setRuntimeSnapshot(snapshot);
          applyMeetingCandidate("sse_snapshot", snapshot.meetingId);
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
        if (sseAttemptRef.current > SPECTATOR_SSE_MAX_RETRIES) {
          setTechnicalError((prev) =>
            prev ?? "runtime_stream_unavailable: SSE нестабилен, переходим в медленный reconnect."
          );
          sseSlowModeRef.current = true;
        }
        const exp = Math.min(sseAttemptRef.current - 1, 5);
        const delayMs = sseSlowModeRef.current
          ? SPECTATOR_SSE_SLOW_RETRY_MS
          : Math.min(30_000, 1000 * 2 ** exp);
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
  }, [applyMeetingCandidate, effectiveMeetingId]);

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
  void videoStatus;

  return (
    <div className="min-h-screen bg-[#e9edf4] px-4 py-6 text-slate-800 sm:px-6 sm:py-8 md:px-10">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6">
        {/* === Header card: глобальный статус интервью + контекст === */}
        <Card className="rounded-2xl border border-white/60 bg-[#dce2eb]/70 shadow-sm">
          <CardHeader className="pb-2 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold text-slate-700">Наблюдение за интервью</CardTitle>
              <div className="flex items-center gap-2">
                <InterviewStatusBadge status={interviewStatus} />
                <span className="text-[11px] text-slate-500">{loading ? "Обновление…" : "Статус"}</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pb-4 text-sm text-slate-700">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-slate-600">
              <span className="truncate font-medium text-slate-800">{candidateName || "—"}</span>
              <span className="text-slate-400" aria-hidden>
                ·
              </span>
              <span className="truncate">{companyName || "—"}</span>
              {jobAiId ? (
                <>
                  <span className="text-slate-400" aria-hidden>
                    ·
                  </span>
                  <span className="shrink-0">ID {jobAiId}</span>
                </>
              ) : null}
            </div>

            {error ? (
              <div className="w-full max-w-[720px] rounded-lg bg-rose-100 px-3 py-2 text-rose-700">
                <p className="text-sm">{error}</p>
                {jobAiId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 rounded-md px-2 text-[11px]"
                    onClick={() => {
                      void getInterviewById(jobAiId, true).then(setDetail).catch(() => undefined);
                    }}
                  >
                    Повторить
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* Waiting info row (compact, neutral). Terminal state is reflected by status badge only. */}
            {!canConnect ? (
              <div className="w-full max-w-[720px] rounded-lg border border-white/60 bg-white/55 px-3 py-2 text-slate-700 shadow-sm">
                <p className="text-[12px] font-medium">Ожидание запуска</p>
                <p className="mt-0.5 text-[11px] text-slate-600">{spectatorWaitingReason ?? "Видео подключится автоматически после старта интервью."}</p>
              </div>
            ) : null}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 gap-1.5 rounded-lg px-2.5 text-[11px] text-slate-700 hover:bg-white/50"
                onClick={() => {
                  router.push("/");
                }}
                title="Назад"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Назад
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 rounded-lg px-2.5 text-[11px]"
                onClick={() => {
                  if (jobAiId) {
                    void getInterviewById(jobAiId, true).then(setDetail).catch(() => undefined);
                  }
                }}
                title="Обновить"
              >
                <RefreshCw className="size-4" aria-hidden />
                <span className="hidden sm:inline">Обновить</span>
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-9 rounded-lg px-2.5 text-[11px]"
                onClick={() => {
                  router.push(jobAiId ? `/?jobAiId=${encodeURIComponent(jobAiId)}` : "/");
                }}
                title="Открыть HR-панель"
              >
                HR
              </Button>
              {terminalByProjection ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hidden h-9 gap-1.5 rounded-lg px-2.5 text-[11px] text-slate-600 hover:bg-white/50 sm:inline-flex"
                  onClick={() => {
                    if (typeof window === "undefined") return;
                    const url = new URL(window.location.href);
                    url.searchParams.set("popout", "1");
                    window.open(url.toString(), "_blank", "noopener,noreferrer,width=1520,height=980");
                  }}
                  title="Открыть в отдельном окне"
                >
                  <ExternalLink className="size-4" aria-hidden />
                  <span className="hidden md:inline">Окно</span>
                </Button>
              )}
            </div>

            {null}
          </CardContent>
        </Card>

        {/* === Session canvas (candidate + HR + observer PiP) === */}
        <main className="grid grid-cols-1 gap-8">
          <div className="flex min-h-0 min-w-0 flex-col">
            <ObserverStreamCard
              title="Наблюдатель"
              participantName="Наблюдатель"
              candidateDisplayName={candidateName || "Кандидат"}
              agentAvatarImageUrl="/anna.jpg"
              meetingId={effectiveMeetingId}
              streamCallId={resolvedStreamCallId || null}
              streamCallType={resolvedStreamCallType || null}
              observerAccessMode={observerAccessMode}
              enabled={canConnect}
              visible
              talkMode={observerControl.talk}
              allowVisibilityToggle={false}
              spectatorDashboardLayout
              showSelfPreview
              sessionEnded={sessionTerminal}
              waitingReason={spectatorWaitingReason}
              joinToken={spectatorJoinToken}
              observerTicket={spectatorObserverTicket}
              viewerKey={spectatorViewerKey}
              onObserverTicketRefresh={(ticket) => {
                if (typeof window === "undefined") return;
                const next = ticket.trim();
                if (!next) return;
                setSpectatorObserverTicket(next);
                if (!jobAiId) return;
                const storageKey = `nullxes:spectator:credentials:${jobAiId}`;
                try {
                  window.sessionStorage.setItem(
                    storageKey,
                    JSON.stringify({ observerTicket: next, viewerKey: spectatorViewerKey ?? undefined })
                  );
                } catch {
                  /* noop */
                }
              }}
              onObserverTicketInvalid={() => {
                if (typeof window === "undefined") return;
                setSpectatorObserverTicket(null);
                if (!jobAiId) return;
                const storageKey = `nullxes:spectator:credentials:${jobAiId}`;
                try {
                  window.sessionStorage.removeItem(storageKey);
                } catch {
                  /* noop */
                }
              }}
              onTalkModeChange={() => {
                // Spectator is hard read-only in this flow.
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
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#e9edf4] text-slate-600">Загрузка…</div>}>
      <SpectatorBody />
    </Suspense>
  );
}
