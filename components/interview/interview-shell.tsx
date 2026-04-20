"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInterviewSession, type InterviewStartContext } from "@/hooks/use-interview-session";
import {
  decideCandidateAdmission,
  getCandidateAdmissionStatus,
  getInterviewById,
  getMeetingDetail,
  isApiRequestError,
  issueCandidateJoinLink,
  listInterviews,
  type CandidateAdmissionStatus,
  type InterviewDetail,
  type InterviewListRow,
  type JoinLinkIssued
} from "@/lib/api";
import { extractCoreFieldsFromInterviewRaw, mergeStartContextWithInterviewDetail } from "@/lib/interview-detail-fields";
import { normalizeInterviewListRows } from "@/lib/normalize-interview-list-row";
import { sortInterviewListRowsNewestFirst } from "@/lib/sort-interview-list-rows";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import {
  getObserverControlState,
  resolveObserverTalkState,
  resolveObserverVisibilityState,
  setObserverControlState,
  subscribeObserverControlState,
  type ObserverControlState
} from "@/lib/observer-control";
import {
  extractEntryCandidateFromPastedUrl,
  extractJobAiIdFromEntryUrl,
  resolveHrCandidateEntryBasePath,
  withCandidateEntryQuery
} from "@/lib/candidate-entry-url";
import { formatCandidateMeetingLobbyMessage } from "@/lib/meeting-at-guard";
import {
  buildGatewayVsExtractorHint,
  diagnosticsFromInterviewDetail,
  isInterviewContextDebugEnabled,
  logInterviewContextDiagnostics
} from "@/lib/interview-context-diagnostics";
import { deriveSessionUiState, type SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { AvatarStreamCard } from "./avatar-stream-card";
import { CandidateStreamCard } from "./candidate-stream-card";
import { InterviewsTablePreview } from "./interviews-table-preview";
import { MeetingHeader } from "./meeting-header";
import { InterviewSummaryDisplay } from "./interview-summary-display";
import { ObserverStreamCard } from "./observer-stream-card";
import { HrInsightPanel } from "./hr-insight-panel";
import { InterviewPhaseIndicator } from "./interview-phase-indicator";
import { AgentStateIndicator } from "./agent-state-indicator";
import { LiveCaptionsOverlay } from "./live-captions";
import { ThankYouScreen } from "./thank-you-screen";
import {
  ExitConfirmationDialog,
  type ExitConfirmationMode
} from "./exit-confirmation-dialog";
import { SessionCountdownDialog } from "./session-countdown-dialog";
import { releaseCandidateAdmission, sendRealtimeEvent } from "@/lib/api";
import { useSessionCountdown } from "@/hooks/use-session-countdown";
import type { ConnectionQualityReading } from "@/hooks/use-connection-quality";
import { mapPhaseToStatus } from "@/lib/interview-status";

const INTERVIEW_MAX_MINUTES = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_INTERVIEW_MAX_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();
const INTERVIEW_WARN_AT_SECONDS = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_INTERVIEW_WARN_AT_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
})();
const INTERVIEW_EXTEND_BY_MINUTES = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_INTERVIEW_EXTEND_BY_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();

const HARD_CONTEXT_GUARD_ENABLED = process.env.NEXT_PUBLIC_INTERVIEW_HARD_GUARD === "1";
const SHOW_INTERNAL_DEBUG_UI = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";
/**
 * Observer (third participant panel) — the Stream-level spectator tile that
 * shows the live observer in the 3-column dashboard. This is the production
 * default: the right column in the HR dashboard is the Observer, exactly as
 * before the P4 experiment. Can be disabled via
 * NEXT_PUBLIC_ENABLE_OBSERVER_PANEL="0" for the HR-only 2-column layout.
 */
const OBSERVER_PANEL_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_OBSERVER_PANEL !== "0";
/**
 * HR Insight Panel (P4) — live transcript + quick flags + summary. This is
 * an ADDITIONAL surface, not a replacement for the Observer. It lives on the
 * dedicated HR panel route / button and is off by default in the main grid;
 * flip NEXT_PUBLIC_ENABLE_HR_INSIGHT_PANEL="1" to reintroduce it into the
 * main dashboard grid (only takes effect when the Observer column is off).
 */
const HR_INSIGHT_PANEL_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_HR_INSIGHT_PANEL === "1";
const INTERVIEWS_PAGE_SIZE = 8;
const DEFAULT_OBSERVER_CONTROL: ObserverControlState = {
  visibility: "visible",
  talk: "off",
  updatedAt: ""
};

function isJobAiNotConfiguredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("JobAI API is not configured") || message.includes("not configured");
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toAbsoluteUrl(pathOrUrl: string, origin: string): string {
  if (!pathOrUrl) {
    return "";
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return `${origin}${pathOrUrl}`;
}

export function InterviewShell() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "/";
  /** URL flag for candidate-side polling / auto-start / lobby hints — layout is always the full 3-column operator UI. */
  const isCandidateFlow = useMemo(() => searchParams.get("entry") === "candidate", [searchParams]);

  const requestedInterviewId = useMemo(() => {
    const raw = searchParams.get("jobAiId");
    if (!raw) {
      return null;
    }
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  }, [searchParams]);
  const {
    start,
    stop,
    markFailed,
    meetingId,
    sessionId,
    avatarReady,
    statusLabel,
    phase,
    error,
    remoteAudioStream,
    setObserverTalkIsolation,
    hydrateActiveSession,
    runtimeRecoveryState,
    lastInterviewSummary,
    lastAgentContextTrace,
    flowPhase,
    agentState,
    questionsAsked,
    latestCaptions,
    transcripts
  } =
    useInterviewSession();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const candidateRuntimeBootstrapRef = useRef(false);
  const [origin, setOrigin] = useState("");
  const [rows, setRows] = useState<InterviewListRow[]>([]);
  const [rowsTotalCount, setRowsTotalCount] = useState(0);
  const [rowsPage, setRowsPage] = useState(1);
  const [selectedInterviewId, setSelectedInterviewId] = useState<number | null>(null);
  const [selectedInterviewDetail, setSelectedInterviewDetail] = useState<InterviewDetail | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsWarning, setRowsWarning] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [observerControl, setObserverControl] = useState<ObserverControlState>(DEFAULT_OBSERVER_CONTROL);
  const [candidateAdmission, setCandidateAdmission] = useState<CandidateAdmissionStatus | null>(null);
  const [candidateAdmissionError, setCandidateAdmissionError] = useState<string | null>(null);
  const [candidateAdmissionBusy, setCandidateAdmissionBusy] = useState(false);
  const [meetingSummaryFromServer, setMeetingSummaryFromServer] = useState<InterviewSummaryPayload | null>(null);
  const [exitDialog, setExitDialog] = useState<{ open: boolean; mode: ExitConfirmationMode; busy: boolean }>({
    open: false,
    mode: "leave",
    busy: false
  });
  /**
   * Local "joined at" anchor for the session countdown. Set on the first
   * transition into `phase === "connected"` and reset on disconnect so the
   * timer starts fresh on every meeting.
   */
  const [joinedAtMs, setJoinedAtMs] = useState<number | null>(null);
  const [countdownDismissed, setCountdownDismissed] = useState(false);
  const autoEndFiredRef = useRef(false);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQualityReading | null>(null);
  const poorSinceMsRef = useRef<number | null>(null);
  const lastPoorToastAtMsRef = useRef<number>(0);

  useEffect(() => {
    candidateRuntimeBootstrapRef.current = false;
  }, [selectedInterviewId, isCandidateFlow]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.srcObject = remoteAudioStream;
  }, [remoteAudioStream]);

  const busy = phase === "starting" || phase === "stopping";

  // Track first time we entered the "connected" phase — this is the anchor
  // for the session-countdown timer. We deliberately do NOT use start time
  // of the API call: only the moment when WebRTC actually connected counts.
  useEffect(() => {
    if (phase === "connected") {
      setJoinedAtMs((current) => current ?? Date.now());
      autoEndFiredRef.current = false;
    } else if (phase === "idle" || phase === "failed") {
      setJoinedAtMs(null);
      setCountdownDismissed(false);
      autoEndFiredRef.current = false;
    }
  }, [phase]);

  const sessionCountdown = useSessionCountdown({
    active: phase === "connected" && !!meetingId,
    startedAtMs: joinedAtMs,
    maxMinutes: INTERVIEW_MAX_MINUTES,
    warnAtSeconds: INTERVIEW_WARN_AT_SECONDS
  });

  useEffect(() => {
    setOrigin(typeof window !== "undefined" ? window.location.origin : "");
  }, []);

  useEffect(() => {
    if (!requestedInterviewId) {
      return;
    }
    setSelectedInterviewId(requestedInterviewId);
  }, [requestedInterviewId]);

  const selectedRow = useMemo(
    () => rows.find((entry) => entry.jobAiId === selectedInterviewId) ?? null,
    [rows, selectedInterviewId]
  );
  const selectedCandidateEntryPath = useMemo(() => {
    if (!selectedRow) {
      return "";
    }
    const base = resolveHrCandidateEntryBasePath(selectedRow.candidateEntryPath, selectedRow.jobAiId);
    return withCandidateEntryQuery(base);
  }, [selectedRow]);

  /**
   * Per-jobAiId cache of signed candidate JWT links.
   * Auto-issued via POST /interviews/:id/links/candidate when HR selects a row,
   * so the input in the header shows the new `/join/candidate/<JWT>` URL by default
   * (instead of the legacy `?jobAiId=…&entry=candidate` shorthand). The legacy URL
   * is still accepted on the candidate entry route for backward compatibility.
   *
   * Refresh strategy: re-issue when cache miss OR remaining TTL < 5 minutes,
   * to avoid handing the candidate a token that expires while they're typing.
   */
  const [signedCandidateLinks, setSignedCandidateLinks] = useState<
    Record<number, JoinLinkIssued>
  >({});
  const signedLinkInflightRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const id = selectedRow?.jobAiId;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return;
    }
    const cached = signedCandidateLinks[id];
    const now = Date.now();
    const valid = cached && cached.expiresAt - now > 5 * 60 * 1000;
    if (valid) {
      return;
    }
    if (signedLinkInflightRef.current.has(id)) {
      return;
    }
    signedLinkInflightRef.current.add(id);
    issueCandidateJoinLink(id)
      .then((issued) => {
        setSignedCandidateLinks((prev) => ({ ...prev, [id]: issued }));
      })
      .catch(() => {
        // Silent fall-through: input keeps showing the legacy `?jobAiId=` URL
        // so HR is never blocked from copying *something*. The "Скопировать ссылку"
        // button in the table also retries via issueAndCopyLink with toast on error.
      })
      .finally(() => {
        signedLinkInflightRef.current.delete(id);
      });
  }, [selectedRow?.jobAiId, signedCandidateLinks]);

  const selectedCandidateSignedUrl = useMemo(() => {
    const id = selectedRow?.jobAiId;
    if (typeof id !== "number") return null;
    return signedCandidateLinks[id]?.url ?? null;
  }, [selectedRow?.jobAiId, signedCandidateLinks]);

  const selectedInterviewDetailMatched = useMemo(() => {
    if (!selectedInterviewDetail || !selectedInterviewId) {
      return null;
    }
    return selectedInterviewDetail.interview.id === selectedInterviewId ? selectedInterviewDetail : null;
  }, [selectedInterviewDetail, selectedInterviewId]);
  const observerVisible = observerControl.visibility === "visible";
  const observerTalkMode = observerControl.talk;

  const recoveredMeetingId =
    meetingId ?? selectedRow?.nullxesMeetingId ?? selectedInterviewDetailMatched?.projection.nullxesMeetingId ?? null;
  const recoveredSessionIdRaw =
    sessionId ?? selectedRow?.sessionId ?? selectedInterviewDetailMatched?.projection.sessionId ?? null;
  const recoveredSessionId =
    typeof recoveredSessionIdRaw === "string" && recoveredSessionIdRaw.trim() ? recoveredSessionIdRaw.trim() : null;
  const recoveredRuntimeActive =
    (selectedRow?.nullxesStatus ?? selectedInterviewDetailMatched?.projection.nullxesStatus) === "in_meeting";
  const selectedNullxesStatus = selectedRow?.nullxesStatus ?? selectedInterviewDetailMatched?.projection.nullxesStatus;
  const selectedJobAiStatus = selectedRow?.jobAiStatus ?? selectedInterviewDetailMatched?.projection.jobAiStatus;
  const completedInterviewLocked = selectedNullxesStatus === "completed" || selectedJobAiStatus === "completed";
  /** Одинаковый «арбитр» для трёх Stream-колонок: не поднимаем видео до meeting+session, чтобы кандидат и HR не расходились по фазе. */
  const streamSurfaceEnabled =
    phase === "connected" && !completedInterviewLocked && Boolean(recoveredMeetingId && recoveredSessionId);
  const hasInterviewSelection = Boolean(selectedRow || selectedInterviewDetailMatched);

  // Auto-stop the meeting once the countdown hits zero. Fires exactly once per
  // session via autoEndFiredRef even if React re-renders us between the
  // expired tick and the stop()/state-reset call below.
  useEffect(() => {
    if (!sessionCountdown.state.expired) return;
    if (autoEndFiredRef.current) return;
    if (!meetingId) return;
    autoEndFiredRef.current = true;
    const jid = selectedInterviewId ?? selectedRow?.jobAiId;
    const activeSessionId = sessionId;
    const durationMs = joinedAtMs ? Date.now() - joinedAtMs : null;
    if (activeSessionId) {
      void sendRealtimeEvent(activeSessionId, {
        type: "session.update",
        source: "frontend",
        message: "auto_end_triggered",
        ...(durationMs ? { durationMs } : {})
      }).catch(() => undefined);
    }
    void stop(typeof jid === "number" ? { interviewId: jid } : undefined);
  }, [
    joinedAtMs,
    meetingId,
    selectedInterviewId,
    selectedRow?.jobAiId,
    sessionCountdown.state.expired,
    sessionId,
    stop
  ]);

  // Track sustained poor connection and surface a toast at most once per minute.
  // The candidate-stream-card pushes quality readings up via onQualityChange.
  useEffect(() => {
    if (!connectionQuality) {
      poorSinceMsRef.current = null;
      return;
    }
    const isPoorish = connectionQuality.quality === "poor" || connectionQuality.quality === "offline";
    if (!isPoorish) {
      poorSinceMsRef.current = null;
      return;
    }
    const now = Date.now();
    if (poorSinceMsRef.current === null) {
      poorSinceMsRef.current = now;
      return;
    }
    if (now - poorSinceMsRef.current < 30_000) return;
    if (now - lastPoorToastAtMsRef.current < 60_000) return;
    lastPoorToastAtMsRef.current = now;
    if (connectionQuality.quality === "offline") {
      toast.error("Соединение пропало", {
        description: "Проверьте Wi-Fi или мобильную сеть. Сессия восстановится автоматически когда интернет вернётся."
      });
    } else {
      toast.warning("Качество соединения слабое", {
        description: "Ответы могут не дойти до агента. Рекомендуем подключиться к Wi-Fi."
      });
    }
  }, [connectionQuality]);

  const candidateFio = useMemo(() => {
    const sourceFullName = selectedInterviewDetailMatched?.prototypeCandidate?.sourceFullName?.trim();
    if (sourceFullName) {
      return sourceFullName;
    }
    const fromRow = [selectedRow?.candidateFirstName, selectedRow?.candidateLastName].filter(Boolean).join(" ").trim();
    if (fromRow) {
      return fromRow;
    }
    const fromInterview = [
      selectedInterviewDetailMatched?.interview.candidateFirstName,
      selectedInterviewDetailMatched?.interview.candidateLastName
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    return fromInterview;
  }, [selectedInterviewDetailMatched, selectedRow]);

  const interviewStartContext = useMemo<InterviewStartContext | undefined>(() => {
    if (!selectedRow && !selectedInterviewDetailMatched) {
      return undefined;
    }
    const rawInterview = selectedInterviewDetailMatched?.interview as Record<string, unknown> | undefined;
    const ext = rawInterview ? extractCoreFieldsFromInterviewRaw(rawInterview) : {};
    const inv = selectedInterviewDetailMatched?.interview;
    const first =
      candidateFio.trim() ||
      selectedRow?.candidateFirstName ||
      inv?.candidateFirstName ||
      "";
    const last = selectedRow?.candidateLastName || inv?.candidateLastName || "";
    const full = candidateFio.trim() || [first, last].filter(Boolean).join(" ").trim();
    return {
      candidateFirstName: first || undefined,
      candidateLastName: last || undefined,
      candidateFullName: full || undefined,
      jobTitle: ext.jobTitle ?? inv?.jobTitle,
      vacancyText: ext.vacancyText ?? inv?.vacancyText,
      companyName: selectedRow?.companyName || ext.companyName || inv?.companyName,
      greetingSpeech:
        (inv?.greetingSpeechResolved as string | undefined) ?? inv?.greetingSpeech,
      finalSpeech: (inv?.finalSpeechResolved as string | undefined) ?? inv?.finalSpeech,
      questions: ext.questions ?? (typeof inv?.specialty === "object" && inv?.specialty ? inv.specialty.questions : undefined),
      specialtyName: ext.specialtyName ?? (typeof inv?.specialty === "object" && inv?.specialty ? inv.specialty.name : undefined)
    };
  }, [candidateFio, selectedInterviewDetailMatched, selectedRow]);

  useEffect(() => {
    if (!isInterviewContextDebugEnabled() || !selectedInterviewDetailMatched) {
      return;
    }
    const diag = diagnosticsFromInterviewDetail(
      selectedInterviewDetailMatched,
      interviewStartContext,
      "shell:interviewStartContext",
      { interviewId: selectedInterviewDetailMatched.interview.id }
    );
    const raw = selectedInterviewDetailMatched.interview as Record<string, unknown>;
    logInterviewContextDiagnostics("shell:interviewStartContext", diag, {
      gatewayHint: buildGatewayVsExtractorHint(raw)
    });
  }, [interviewStartContext, selectedInterviewDetailMatched]);

  useEffect(() => {
    const meetingId = selectedRow?.nullxesMeetingId;
    if (!meetingId || selectedRow?.nullxesStatus !== "completed") {
      setMeetingSummaryFromServer(null);
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
    const load = async () => {
      try {
        const res = await getMeetingDetail(meetingId);
        const raw = res.meeting?.metadata?.interviewSummary;
        if (cancelled || !raw || typeof raw !== "object") {
          return;
        }
        setMeetingSummaryFromServer(raw as InterviewSummaryPayload);
      } catch (err) {
        if (cancelled) return;
        if (isApiRequestError(err) && err.status === 404) {
          // meeting record was purged on backend (e.g. after restart without persisted store) —
          // stop polling permanently so we don't flood gateway logs with 404s.
          setMeetingSummaryFromServer(null);
          stopPolling();
          return;
        }
        setMeetingSummaryFromServer(null);
      }
    };
    void load();
    timer = setInterval(() => {
      void load();
    }, 8000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [selectedRow?.nullxesMeetingId, selectedRow?.nullxesStatus]);

  const contextReadiness = useMemo(() => {
    const candidateReady = Boolean(
      interviewStartContext?.candidateFullName?.trim() ||
        interviewStartContext?.candidateFirstName?.trim() ||
        interviewStartContext?.candidateLastName?.trim()
    );
    const jobTitleReady = Boolean(interviewStartContext?.jobTitle?.trim());
    const vacancyTextReady = Boolean(interviewStartContext?.vacancyText?.trim());
    const companyReady = Boolean(interviewStartContext?.companyName?.trim());
    const questionsCount = interviewStartContext?.questions?.length ?? 0;
    const questionsReady = questionsCount > 0;
    return {
      candidateReady,
      jobTitleReady,
      vacancyTextReady,
      companyReady,
      questionsReady,
      questionsCount
    };
  }, [interviewStartContext]);

  const contextHardReady =
    contextReadiness.candidateReady &&
    contextReadiness.jobTitleReady &&
    contextReadiness.vacancyTextReady &&
    contextReadiness.companyReady &&
    contextReadiness.questionsReady;

  const candidateWaitingHint = useMemo(() => {
    if (!isCandidateFlow) {
      return null;
    }
    if (completedInterviewLocked) {
      return null;
    }
    if (phase === "connected" || phase === "starting" || busy) {
      return null;
    }
    if (phase === "failed") {
      return null;
    }
    const detail = selectedInterviewDetailMatched;
    if (!detail && !detailError) {
      return "Загружаем расписание интервью…";
    }
    if (detailError || !detail) {
      return null;
    }
    const nx = detail.projection.nullxesStatus;
    const js = detail.interview.status;
    const meetingAtRaw = detail.interview.meetingAt ?? selectedRow?.meetingAt;
    const meetingTs = meetingAtRaw ? new Date(meetingAtRaw).getTime() : NaN;
    const meetingPassed = Number.isFinite(meetingTs) && Date.now() >= meetingTs;
    if (nx === "in_meeting") {
      const mid = detail.projection.nullxesMeetingId;
      const sid = detail.projection.sessionId;
      if (!mid?.trim() || !sid?.trim()) {
        return "Ожидайте, пока HR откроет сессию.";
      }
    }
    if (meetingAtRaw && !meetingPassed) {
      return formatCandidateMeetingLobbyMessage(meetingAtRaw);
    }
    if (js !== "received" && js !== "pending") {
      return "Ожидайте, пока интервью будет готово к старту (статус JobAI должен позволять подключение).";
    }
    if (HARD_CONTEXT_GUARD_ENABLED && !contextHardReady) {
      return "Подготавливаем данные для интервью…";
    }
    return "Подключаем вас к интервью…";
  }, [
    busy,
    completedInterviewLocked,
    contextHardReady,
    detailError,
    isCandidateFlow,
    phase,
    selectedInterviewDetailMatched,
    selectedRow?.meetingAt
  ]);

  const sessionUiState: SessionUIState = useMemo(
    () =>
      deriveSessionUiState({
        phase,
        completedInterviewLocked,
        contextHardReady,
        hardContextGuardEnabled: HARD_CONTEXT_GUARD_ENABLED,
        hasInterviewSelection
      }),
    [phase, completedInterviewLocked, contextHardReady, hasInterviewSelection]
  );

  const prioritizedSessionBanner = useMemo(() => {
    if (hasInterviewSelection && completedInterviewLocked) {
      return {
        tone: "completed" as const,
        className: "border-amber-200 bg-amber-50 text-amber-900",
        body: "Эта сессия уже завершена. Повторный старт отключен."
      };
    }
    if (hasInterviewSelection && !contextHardReady) {
      return {
        tone: "blocked" as const,
        className: "border-amber-200 bg-amber-50 text-amber-900",
        body: HARD_CONTEXT_GUARD_ENABLED
          ? "Start Session заблокирован: для безопасного запуска агента нужны кандидат, должность, текст вакансии, компания и вопросы из JobAI."
          : "Внимание: контекст интервью неполный (кандидат/должность/текст вакансии/компания/вопросы)."
      };
    }
    if (isCandidateFlow && candidateWaitingHint) {
      return {
        tone: "lobby" as const,
        className: "border-sky-200 bg-sky-50 text-sky-950",
        body: candidateWaitingHint
      };
    }
    return null;
  }, [
    candidateWaitingHint,
    completedInterviewLocked,
    contextHardReady,
    hasInterviewSelection,
    isCandidateFlow
  ]);

  const duplicateJobAiIds = useMemo(() => {
    const byFingerprint = new Map<string, number[]>();
    for (const row of rows) {
      const firstName = safeText((row as { candidateFirstName?: unknown }).candidateFirstName);
      const lastName = safeText((row as { candidateLastName?: unknown }).candidateLastName);
      const legacyCandidate = safeText((row as { candidateName?: unknown }).candidateName);
      const companyName = safeText((row as { companyName?: unknown }).companyName);
      const key = [
        firstName || legacyCandidate,
        lastName,
        companyName,
        new Date(row.meetingAt).toISOString()
      ]
        .map((part) => part.toLowerCase())
        .join("|");
      const bucket = byFingerprint.get(key) ?? [];
      bucket.push(row.jobAiId);
      byFingerprint.set(key, bucket);
    }
    return Array.from(byFingerprint.values())
      .filter((ids) => ids.length > 1)
      .flat();
  }, [rows]);

  const loadInterviews = useCallback(async () => {
    setLoadingRows(true);
    setRowsError(null);
    setRowsWarning(null);
    try {
      let list: { interviews: InterviewListRow[]; count: number };
      const skip = (Math.max(1, rowsPage) - 1) * INTERVIEWS_PAGE_SIZE;
      try {
        list = await listInterviews({ skip, take: INTERVIEWS_PAGE_SIZE, sync: true });
      } catch (syncErr) {
        if (isJobAiNotConfiguredError(syncErr)) {
          setRowsWarning(
            "JobAI API не настроен на gateway — загрузка списка без синхронизации (только локальный кэш). Укажите JOBAI_* в .env бэкенда для GET/POST по Swagger."
          );
          list = await listInterviews({ skip, take: INTERVIEWS_PAGE_SIZE, sync: false });
        } else {
          throw syncErr;
        }
      }

      const ordered = sortInterviewListRowsNewestFirst(normalizeInterviewListRows(list.interviews));
      setRows(ordered);
      setRowsTotalCount(list.count);
      setSelectedInterviewId((current) => {
        if (requestedInterviewId) {
          return requestedInterviewId;
        }
        if (current && ordered.some((item) => item.jobAiId === current)) {
          return current;
        }
        return ordered[0]?.jobAiId ?? null;
      });
    } catch (loadError) {
      setRowsError(loadError instanceof Error ? loadError.message : "Failed to load interviews");
    } finally {
      setLoadingRows(false);
    }
  }, [requestedInterviewId, rowsPage]);

  const loadInterviewDetail = useCallback(async (jobAiId: number, forceSync = false) => {
    setDetailError(null);
    try {
      const detail = await getInterviewById(jobAiId, forceSync);
      setSelectedInterviewDetail(detail);
    } catch (detailErr) {
      const message = detailErr instanceof Error ? detailErr.message : "Failed to load interview details";
      if (!forceSync && message.includes("interviews.not_found")) {
        try {
          const synced = await getInterviewById(jobAiId, true);
          setSelectedInterviewDetail(synced);
          setDetailError(null);
          return;
        } catch {
          // Fall through to soft error handling below.
        }
      }
      setSelectedInterviewDetail(null);
      setDetailError(message);
    }
  }, []);

  useEffect(() => {
    void loadInterviews();
  }, [loadInterviews]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(rowsTotalCount / INTERVIEWS_PAGE_SIZE));
    if (rowsPage > totalPages) {
      setRowsPage(totalPages);
    }
  }, [rowsPage, rowsTotalCount]);

  useEffect(() => {
    if (!selectedInterviewId) {
      setSelectedInterviewDetail(null);
      return;
    }
    const hasRowInList = rows.some((entry) => entry.jobAiId === selectedInterviewId);
    void loadInterviewDetail(selectedInterviewId, !hasRowInList);
  }, [loadInterviewDetail, rows, selectedInterviewId]);

  useEffect(() => {
    if (!isCandidateFlow || !selectedInterviewId) {
      return;
    }
    const timer = setInterval(() => {
      void loadInterviewDetail(selectedInterviewId, true);
    }, 2500);
    return () => clearInterval(timer);
  }, [isCandidateFlow, loadInterviewDetail, selectedInterviewId]);

  const handleEntryUrlCommit = useCallback(
    (value: string) => {
      const parsedId = extractJobAiIdFromEntryUrl(value);
      if (!parsedId) {
        toast.error("Ссылка не распознана", {
          description:
            "Ожидается ссылка /join/candidate/<JWT>, /join/spectator/<JWT> или legacy ?jobAiId=<число>."
        });
        return;
      }
      const entryCandidate = extractEntryCandidateFromPastedUrl(value);
      const params = new URLSearchParams();
      params.set("jobAiId", String(parsedId));
      if (entryCandidate) {
        params.set("entry", "candidate");
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);

      const existsInRows = rows.some((entry) => entry.jobAiId === parsedId);
      setSelectedInterviewId(parsedId);
      void loadInterviewDetail(parsedId, !existsInRows);
      if (!existsInRows) {
        void loadInterviews();
      }
    },
    [loadInterviewDetail, loadInterviews, pathname, router, rows]
  );

  useEffect(() => {
    if (phase !== "connected") {
      return;
    }
    void setObserverTalkIsolation(false);
  }, [phase, setObserverTalkIsolation]);

  useEffect(() => {
    if (!selectedInterviewId) {
      setObserverControl(DEFAULT_OBSERVER_CONTROL);
      return;
    }
    setObserverControl(getObserverControlState(selectedInterviewId));
    return subscribeObserverControlState(selectedInterviewId, setObserverControl);
  }, [selectedInterviewId]);

  useEffect(() => {
    if (!selectedInterviewId) {
      return;
    }
    if (!observerVisible && observerControl.talk !== "off") {
      setObserverControlState(selectedInterviewId, {
        visibility: "hidden",
        talk: "off",
        updatedAt: new Date().toISOString()
      });
    }
  }, [observerControl.talk, observerVisible, selectedInterviewId]);

  useEffect(() => {
    const talkActive = phase === "connected" && observerVisible && observerTalkMode === "on";
    void setObserverTalkIsolation(talkActive);
  }, [observerTalkMode, observerVisible, phase, setObserverTalkIsolation]);

  useEffect(() => {
    if (!recoveredRuntimeActive || meetingId || sessionId || !recoveredMeetingId || !recoveredSessionId) {
      return;
    }
    hydrateActiveSession({
      meetingId: recoveredMeetingId,
      sessionId: recoveredSessionId,
      interviewId: selectedInterviewId ?? undefined
    });
  }, [
    hydrateActiveSession,
    meetingId,
    recoveredMeetingId,
    recoveredRuntimeActive,
    recoveredSessionId,
    selectedInterviewId,
    sessionId
  ]);

  const loadCandidateAdmission = useCallback(async () => {
    if (!recoveredMeetingId) {
      setCandidateAdmission(null);
      setCandidateAdmissionError(null);
      return;
    }
    try {
      const status = await getCandidateAdmissionStatus(recoveredMeetingId);
      setCandidateAdmission(status);
      setCandidateAdmissionError(null);
    } catch (admissionError) {
      setCandidateAdmissionError(
        admissionError instanceof Error ? admissionError.message : "Не удалось загрузить admission-состояние кандидата."
      );
    }
  }, [recoveredMeetingId]);

  useEffect(() => {
    if (!recoveredMeetingId || phase !== "connected") {
      setCandidateAdmission(null);
      setCandidateAdmissionError(null);
      return;
    }
    void loadCandidateAdmission();
    const timer = setInterval(() => {
      void loadCandidateAdmission();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadCandidateAdmission, phase, recoveredMeetingId]);

  const ensureInterviewStart = useCallback(
    async (options?: {
      triggerSource?: string;
      interviewId?: number;
      meetingAt?: string;
      bypassMeetingAtGuard?: boolean;
      interviewContext?: InterviewStartContext;
    }) => {
      if (completedInterviewLocked) {
        throw new Error("Эта сессия уже завершена. Повторный старт отключен.");
      }
      return start(options);
    },
    [completedInterviewLocked, start]
  );

  /** Open exit confirmation dialog in the requested mode. */
  const openExitDialog = useCallback((mode: ExitConfirmationMode) => {
    setExitDialog({ open: true, mode, busy: false });
  }, []);

  /**
   * Resolve confirmation: end = full stopMeeting + summary; leave = best-effort
   * release admission slot and tear down WebRTC, but keep the meeting open so the
   * candidate can rejoin within the rejoin window (backend default 60s).
   */
  const handleExitConfirm = useCallback(async () => {
    setExitDialog((prev) => ({ ...prev, busy: true }));
    try {
      if (exitDialog.mode === "end") {
        const jid = selectedInterviewId ?? selectedRow?.jobAiId;
        await stop(typeof jid === "number" ? { interviewId: jid } : undefined);
      } else if (recoveredMeetingId) {
        try {
          await releaseCandidateAdmission(recoveredMeetingId, {
            participantId: candidateFio || "candidate",
            reason: "candidate_temporary_leave"
          });
        } catch {
          // best-effort — admission release is optional, the rejoin window still applies.
        }
      }
      setExitDialog({ open: false, mode: exitDialog.mode, busy: false });
      // В обоих режимах («Завершить» и «Выйти») кандидат должен приземлиться
      // на главную. Раньше «Выйти» делал window.location.reload() и кандидат
      // оставался на том же URL с замороженным UI, а «Завершить» просто
      // переводил phase → "completed" и показывал ThankYouScreen, из которого
      // тоже не было явного возврата. По ТЗ: оба пути ведут на "/".
      if (isCandidateFlow && typeof window !== "undefined") {
        window.location.href = "/";
      }
    } catch {
      setExitDialog((prev) => ({ ...prev, busy: false }));
    }
  }, [candidateFio, exitDialog.mode, isCandidateFlow, recoveredMeetingId, selectedInterviewId, selectedRow?.jobAiId, stop]);

  useEffect(() => {
    if (!isCandidateFlow || !selectedInterviewId) {
      return;
    }
    if (phase === "connected" || phase === "starting" || busy) {
      return;
    }
    if (phase === "failed") {
      return;
    }
    if (candidateRuntimeBootstrapRef.current) {
      return;
    }
    const detail = selectedInterviewDetailMatched;
    if (!detail) {
      return;
    }

    const jobStatus = detail.interview.status;
    const nx = detail.projection.nullxesStatus;
    const jobAiProjection = detail.projection.jobAiStatus ?? jobStatus;
    if (jobAiProjection === "completed" || nx === "completed") {
      return;
    }

    const mid = detail.projection.nullxesMeetingId?.trim() ?? "";
    const sid = detail.projection.sessionId?.trim() ?? "";
    if (nx === "in_meeting" && mid && sid) {
      candidateRuntimeBootstrapRef.current = true;
      hydrateActiveSession({ meetingId: mid, sessionId: sid, interviewId: selectedInterviewId });
      return;
    }

    if (jobStatus !== "received" && jobStatus !== "pending") {
      return;
    }

    const meetingAtRaw = detail.interview.meetingAt || selectedRow?.meetingAt;
    if (!meetingAtRaw) {
      return;
    }
    const meetingTs = new Date(meetingAtRaw).getTime();
    if (!Number.isFinite(meetingTs) || Date.now() < meetingTs) {
      return;
    }

    if (HARD_CONTEXT_GUARD_ENABLED && !contextHardReady) {
      return;
    }

    void (async () => {
      try {
        candidateRuntimeBootstrapRef.current = true;
        let contextForStart = interviewStartContext;
        const needSync =
          !contextForStart?.jobTitle ||
          !contextForStart?.vacancyText ||
          !contextForStart?.companyName ||
          (contextForStart?.questions?.length ?? 0) === 0;

        // Кандидат по ссылке: projection списка часто без полного JD / вопросов — всегда тянем sync=1 перед стартом.
        if (needSync || isCandidateFlow) {
          const syncedDetail = await getInterviewById(selectedInterviewId, true);
          setSelectedInterviewDetail(syncedDetail);
          contextForStart = mergeStartContextWithInterviewDetail(interviewStartContext, syncedDetail);
        }

        if (HARD_CONTEXT_GUARD_ENABLED) {
          const ok =
            Boolean(
              contextForStart?.candidateFullName?.trim() ||
                contextForStart?.candidateFirstName?.trim() ||
                contextForStart?.candidateLastName?.trim()
            ) &&
            Boolean(contextForStart?.jobTitle?.trim()) &&
            Boolean(contextForStart?.vacancyText?.trim()) &&
            Boolean(contextForStart?.companyName?.trim()) &&
            (contextForStart?.questions?.length ?? 0) > 0;
          if (!ok) {
            candidateRuntimeBootstrapRef.current = false;
            return;
          }
        }

        await start({
          triggerSource: "candidate_auto_start",
          interviewId: selectedInterviewId,
          meetingAt: meetingAtRaw,
          interviewContext: contextForStart
        });
      } catch {
        candidateRuntimeBootstrapRef.current = false;
      }
    })();
  }, [
    busy,
    candidateFio,
    contextHardReady,
    hydrateActiveSession,
    interviewStartContext,
    isCandidateFlow,
    phase,
    selectedInterviewDetailMatched,
    selectedInterviewId,
    selectedRow?.meetingAt,
    start
  ]);

  return (
    <div className="min-h-screen w-full bg-[#dfe4ec] px-4 py-6 sm:px-6 sm:py-8 md:px-10">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10">
        {isCandidateFlow && !requestedInterviewId ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm">
            В ссылке для кандидата не указан <span className="font-mono">jobAiId</span>. Попросите HR отправить корректную
            ссылку.
          </p>
        ) : null}
        <>
        <MeetingHeader
          status={mapPhaseToStatus({
            phase,
            runtimeRecoveryState,
            completedLocked: completedInterviewLocked,
            contextReady: contextHardReady,
            countdownWarning: sessionCountdown.state.warning,
            mode: isCandidateFlow ? "candidate" : "hr"
          })}
          rawStatusLabel={statusLabel}
          meetingId={recoveredMeetingId}
          sessionId={recoveredSessionId}
          jobAiId={selectedRow?.jobAiId}
          companyName={selectedRow?.companyName ?? interviewStartContext?.companyName}
          jobTitle={interviewStartContext?.jobTitle}
          meetingAt={selectedInterviewDetailMatched?.interview.meetingAt ?? selectedRow?.meetingAt}
          prototypeEntryUrl={
            selectedRow
              ? selectedCandidateSignedUrl
                ?? (origin ? toAbsoluteUrl(selectedCandidateEntryPath, origin) : undefined)
              : undefined
          }
          onEntryUrlCommit={handleEntryUrlCommit}
          candidateFio={candidateFio}
          candidateFirstName={interviewStartContext?.candidateFirstName ?? candidateFio.split(" ")[0]}
          interviewActive={phase === "connected" && !completedInterviewLocked && Boolean(meetingId)}
          onStart={() => {
            // HR-сторона больше не может запускать AI-сессию. Кнопка «Запустить»
            // убрана из meeting-header, этот callback остаётся как safety net на
            // случай, если где-то в дереве его ещё дёрнут — покажем понятное
            // сообщение вместо тихой ошибки. Сама сессия инициируется только
            // переходом кандидата по его уникальной ссылке (candidate-flow).
            toast.info(
              "Интервью запускает кандидат, перейдя по своей персональной ссылке. HR-сторона не инициирует сессию."
            );
          }}
          onStopSession={() => openExitDialog("end")}
          stopSessionDisabled={
            busy || completedInterviewLocked || phase !== "connected" || !meetingId
          }
          onFail={markFailed}
          startDisabled={
            phase === "connected" ||
            busy ||
            !(selectedInterviewId ?? selectedRow?.jobAiId) ||
            completedInterviewLocked ||
            (HARD_CONTEXT_GUARD_ENABLED && !contextHardReady)
          }
          failDisabled={phase === "idle" || busy}
          showDebugActions={SHOW_INTERNAL_DEBUG_UI}
          candidateMode={isCandidateFlow}
        />

        <InterviewSummaryDisplay
          summary={lastInterviewSummary ?? meetingSummaryFromServer}
          title="Итог интервью (саммари)"
        />
        </>
        {error ? (
          <p className="rounded-xl bg-rose-100 px-4 py-2 text-sm text-rose-700 shadow-sm">{error}</p>
        ) : null}
        {rowsWarning ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm">
            {rowsWarning}
          </p>
        ) : null}
        {runtimeRecoveryState === "recovering" ? (
          <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 shadow-sm">
            Восстанавливаем runtime после обновления страницы. Подключение может занять несколько секунд.
          </p>
        ) : null}
        {SHOW_INTERNAL_DEBUG_UI && candidateAdmissionError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 shadow-sm">
            {candidateAdmissionError}
          </p>
        ) : null}
        {SHOW_INTERNAL_DEBUG_UI && candidateAdmission && (candidateAdmission.pending.length > 0 || candidateAdmission.owner) ? (
          <section className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 shadow-sm">
            <p className="font-medium text-slate-800">Admission control кандидата</p>
            <p className="mt-1">
              Текущий владелец слота:{" "}
              {candidateAdmission.owner
                ? `${candidateAdmission.owner.displayName} (${candidateAdmission.owner.participantId.slice(0, 10)}...)`
                : "не назначен"}
            </p>
            {candidateAdmission.pending.length > 0 ? (
              <div className="mt-3 space-y-2">
                {candidateAdmission.pending.map((entry) => (
                  <div key={entry.participantId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-100/70 px-3 py-2">
                    <p className="text-xs text-slate-700">
                      Запрос: {entry.displayName} ({entry.participantId.slice(0, 10)}...)
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                        disabled={candidateAdmissionBusy}
                        onClick={() => {
                          if (!recoveredMeetingId) return;
                          setCandidateAdmissionBusy(true);
                          void decideCandidateAdmission(recoveredMeetingId, {
                            participantId: entry.participantId,
                            action: "approve",
                            decidedBy: "hr_ui"
                          })
                            .then(() => loadCandidateAdmission())
                            .finally(() => setCandidateAdmissionBusy(false));
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-slate-500 px-3 py-1 text-xs text-white disabled:opacity-50"
                        disabled={candidateAdmissionBusy}
                        onClick={() => {
                          if (!recoveredMeetingId) return;
                          setCandidateAdmissionBusy(true);
                          void decideCandidateAdmission(recoveredMeetingId, {
                            participantId: entry.participantId,
                            action: "deny",
                            decidedBy: "hr_ui"
                          })
                            .then(() => loadCandidateAdmission())
                            .finally(() => setCandidateAdmissionBusy(false));
                        }}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        {detailError && !selectedRow && !selectedInterviewDetail && !loadingRows ? (
          <p className="rounded-xl border border-slate-200 bg-white/70 px-4 py-2 text-sm text-slate-700 shadow-sm">
            Не удалось загрузить детали собеседования. Повторите попытку. ({detailError})
          </p>
        ) : null}
        {prioritizedSessionBanner ? (
          <p
            className={`rounded-xl border px-4 py-2 text-sm shadow-sm ${prioritizedSessionBanner.className}`}
            role="status"
            data-session-banner={prioritizedSessionBanner.tone}
          >
            {prioritizedSessionBanner.body}
          </p>
        ) : null}
        {SHOW_INTERNAL_DEBUG_UI ? (
          <section className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 shadow-sm">
              <p className="font-medium text-slate-800">Сигнал HR-аватара</p>
              <p className="mt-1">{avatarReady ? "avatar_ready получен" : "avatar_ready пока не получен"}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 shadow-sm">
              <p className="font-medium text-slate-800">Контекст для агента</p>
              <p className="mt-1">
                {contextReadiness.candidateReady ? "✅" : "⬜"} Кандидат ·{" "}
                {contextReadiness.jobTitleReady ? "✅" : "⬜"} Должность ·{" "}
                {contextReadiness.vacancyTextReady ? "✅" : "⬜"} Вакансия ·{" "}
                {contextReadiness.companyReady ? "✅" : "⬜"} Компания ·{" "}
                {contextReadiness.questionsReady ? "✅" : "⬜"} Вопросы ({contextReadiness.questionsCount})
              </p>
            </div>
            {lastAgentContextTrace?.diagnostics ? (
              <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-slate-700 shadow-sm">
                <p className="text-sm font-medium text-slate-800">Последний контекст, ушедший в агента (session.update)</p>
                <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-50 p-2 text-xs leading-snug">
                  {JSON.stringify(lastAgentContextTrace.diagnostics, null, 2)}
                </pre>
              </div>
            ) : null}
          </section>
        ) : null}

        {isCandidateFlow && flowPhase === "completed" ? (
          <ThankYouScreen
            candidateFirstName={
              interviewStartContext?.candidateFirstName ??
              candidateFio.split(" ")[0]
            }
            jobTitle={interviewStartContext?.jobTitle}
            companyName={interviewStartContext?.companyName}
          />
        ) : (
          <>
            <InterviewPhaseIndicator
              flowPhase={flowPhase}
              questionsAsked={questionsAsked}
              totalQuestions={interviewStartContext?.questions?.length ?? 0}
            />
            {flowPhase === "intro" || flowPhase === "questions" || flowPhase === "closing" ? (
              <div className="flex w-full justify-center">
                <AgentStateIndicator state={agentState} />
              </div>
            ) : null}
            {connectionQuality?.quality === "reconnecting" ? (
              <div className="flex w-full justify-center">
                <span className="rounded-full bg-amber-100 px-4 py-1 text-xs font-medium text-amber-900 shadow-sm animate-pulse">
                  Восстанавливаем соединение…
                </span>
              </div>
            ) : null}
            {connectionQuality?.quality === "offline" ? (
              <div className="flex w-full justify-center">
                <span className="rounded-full bg-rose-100 px-4 py-1 text-xs font-medium text-rose-900 shadow-sm">
                  Нет интернета — соединение восстановится автоматически когда сеть вернётся
                </span>
              </div>
            ) : null}
            <main
              className={cn(
                "relative mt-4 grid grid-cols-1 gap-8 lg:items-stretch lg:gap-6",
                isCandidateFlow || (!OBSERVER_PANEL_ENABLED && !HR_INSIGHT_PANEL_ENABLED)
                  ? "lg:grid-cols-2"
                  : "lg:grid-cols-3",
                sessionUiState === "completed" && "pointer-events-none opacity-60"
              )}
              aria-busy={sessionUiState === "completed" ? "true" : undefined}
            >
          <div className="flex min-h-0 min-w-0 flex-col lg:h-full">
          <CandidateStreamCard
            meetingId={recoveredMeetingId}
            sessionId={recoveredSessionId}
            enabled={streamSurfaceEnabled}
            autoConnectOnEntry={streamSurfaceEnabled}
            participantName={candidateFio.trim() || "Кандидат"}
            interviewId={selectedInterviewId ?? selectedRow?.jobAiId}
            meetingAt={selectedInterviewDetailMatched?.interview.meetingAt ?? selectedRow?.meetingAt}
            interviewContext={interviewStartContext}
            onEnsureInterviewStart={ensureInterviewStart}
            showControls
            sessionEnded={completedInterviewLocked}
            uiState={sessionUiState}
            onQualityChange={setConnectionQuality}
          />
          </div>
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-col lg:h-full lg:static",
              // Mobile-only PiP overlay for the agent tile when the user is
              // in candidate flow. On desktop (lg+) it falls back into the
              // regular grid column. Width / position chosen to match Zoom-like
              // mobile layouts and not overlap the candidate's own face.
              isCandidateFlow &&
                "absolute right-3 top-3 z-20 h-36 w-28 sm:h-44 sm:w-32 lg:relative lg:right-auto lg:top-auto lg:z-auto lg:h-auto lg:w-auto"
            )}
          >
          <AvatarStreamCard
            participantName="HR ассистент"
            enabled={streamSurfaceEnabled}
            avatarReady={avatarReady}
            meetingId={recoveredMeetingId}
            showStreamToolbar={false}
            showStatusBadge
            // Кнопку «Остановить бота» видит только HR. Кандидат
            // не имеет права останавливать AI-интервью и трогать
            // управление аватаром (микрофон/камера/стоп). Для
            // выхода у него есть отдельная кнопка «Выйти».
            showStopAI={!isCandidateFlow && phase === "connected" && Boolean(recoveredMeetingId) && !completedInterviewLocked}
            stopAIDisabled={busy}
            onStopAI={() => {
              const jid = selectedInterviewId ?? selectedRow?.jobAiId;
              void stop(typeof jid === "number" ? { interviewId: jid } : undefined);
            }}
            sessionEnded={completedInterviewLocked}
            uiState={sessionUiState}
            emphasizePrimary
            mobilePip={isCandidateFlow}
          />
          </div>
          {isCandidateFlow ? null : OBSERVER_PANEL_ENABLED ? (
          <div className="flex min-h-0 min-w-0 flex-col lg:h-full">
          <ObserverStreamCard
            title="Наблюдатель"
            participantName="Наблюдатель"
            meetingId={recoveredMeetingId}
            enabled={streamSurfaceEnabled}
            visible={observerVisible}
            talkMode={observerTalkMode}
            mutePlayback
            allowVisibilityToggle
            allowTalkToggle
            sessionEnded={completedInterviewLocked}
            uiState={sessionUiState}
            onVisibleChange={(nextVisible) => {
              if (!selectedInterviewId) {
                return;
              }
              const nextState = resolveObserverVisibilityState(observerControl, nextVisible);
              setObserverControlState(selectedInterviewId, {
                visibility: nextState.visibility,
                talk: nextState.talk,
                updatedAt: new Date().toISOString()
              });
            }}
            onTalkModeChange={(nextTalkMode) => {
              if (!selectedInterviewId) {
                return;
              }
              const nextState = resolveObserverTalkState(observerControl, nextTalkMode);
              setObserverControlState(selectedInterviewId, {
                visibility: nextState.visibility,
                talk: nextState.talk,
                updatedAt: new Date().toISOString()
              });
            }}
          />
          </div>
          ) : HR_INSIGHT_PANEL_ENABLED ? (
          <div className="flex min-h-0 min-w-0 flex-col lg:h-full">
            <HrInsightPanel
              transcripts={transcripts}
              summary={lastInterviewSummary ?? meetingSummaryFromServer}
              sessionEnded={completedInterviewLocked}
              streamEnabled={streamSurfaceEnabled}
              interviewKey={selectedInterviewId ?? selectedRow?.jobAiId ?? recoveredMeetingId}
            />
          </div>
          ) : null}
        </main>
        {isCandidateFlow ? (
          <div className="mt-3 flex w-full justify-center gap-4 sm:gap-3">
            <button
              type="button"
              onClick={() => openExitDialog("leave")}
              disabled={busy || !recoveredMeetingId}
              className="min-h-11 rounded-xl bg-[#d9dee7] px-7 py-3 text-base text-slate-600 shadow-[-6px_-6px_12px_rgba(255,255,255,.85),6px_6px_12px_rgba(163,177,198,.5)] hover:bg-[#d5dbe4] disabled:opacity-40 sm:min-h-10 sm:px-6 sm:py-2 sm:text-sm"
            >
              Выйти
            </button>
            <button
              type="button"
              onClick={() => openExitDialog("end")}
              disabled={busy || !recoveredMeetingId || completedInterviewLocked}
              className="min-h-11 rounded-xl bg-rose-100 px-7 py-3 text-base text-rose-700 shadow-[-6px_-6px_12px_rgba(255,255,255,.85),6px_6px_12px_rgba(163,177,198,.5)] hover:bg-rose-200 disabled:opacity-40 sm:min-h-10 sm:px-6 sm:py-2 sm:text-sm"
            >
              Завершить
            </button>
          </div>
        ) : null}
          </>
        )}
        {isCandidateFlow ? null : (
          <InterviewsTablePreview
            rows={rows}
            page={rowsPage}
            pageSize={INTERVIEWS_PAGE_SIZE}
            totalCount={rowsTotalCount}
            selectedInterviewId={selectedInterviewId}
            duplicateJobAiIds={duplicateJobAiIds}
            loading={loadingRows}
            error={rowsError}
            onRefresh={() => {
              void loadInterviews();
            }}
            onSelect={(row) => {
              setSelectedInterviewId(row.jobAiId);
              const params = new URLSearchParams();
              params.set("jobAiId", String(row.jobAiId));
              const q = params.toString();
              router.replace(q ? `${pathname}?${q}` : pathname);
            }}
            onPageChange={(nextPage) => {
              setRowsPage(nextPage);
            }}
            onCandidateEntryUrlCopied={handleEntryUrlCommit}
          />
        )}
        <audio ref={audioRef} autoPlay />
      </div>
      <LiveCaptionsOverlay
        captions={latestCaptions}
        visible={flowPhase === "intro" || flowPhase === "questions" || flowPhase === "closing"}
      />
      <ExitConfirmationDialog
        mode={exitDialog.mode}
        open={exitDialog.open}
        busy={exitDialog.busy}
        onCancel={() => setExitDialog((prev) => ({ ...prev, open: false }))}
        onConfirm={handleExitConfirm}
      />
      <SessionCountdownDialog
        open={
          sessionCountdown.state.warning &&
          !countdownDismissed &&
          !sessionCountdown.state.expired &&
          phase === "connected"
        }
        msLeft={sessionCountdown.state.msLeft ?? 0}
        extendByMinutes={INTERVIEW_EXTEND_BY_MINUTES}
        onDismiss={() => setCountdownDismissed(true)}
        onExtend={() => {
          sessionCountdown.extend(INTERVIEW_EXTEND_BY_MINUTES);
          setCountdownDismissed(true);
        }}
        onEndNow={() => {
          setCountdownDismissed(true);
          openExitDialog("end");
        }}
      />
    </div>
  );
}
