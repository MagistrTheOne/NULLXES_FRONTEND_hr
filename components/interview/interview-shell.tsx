"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInterviewSession, type InterviewStartContext } from "@/hooks/use-interview-session";
import {
  decideCandidateAdmission,
  getCandidateAdmissionStatus,
  getInterviewById,
  getMeetingDetail,
  listInterviews,
  type CandidateAdmissionStatus,
  type InterviewDetail,
  type InterviewListRow
} from "@/lib/api";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import {
  getObserverControlState,
  resolveObserverTalkState,
  resolveObserverVisibilityState,
  setObserverControlState,
  subscribeObserverControlState,
  type ObserverControlState
} from "@/lib/observer-control";
import { extractEntryCandidateFromPastedUrl, withCandidateEntryQuery } from "@/lib/candidate-entry-url";
import { formatCandidateMeetingLobbyMessage } from "@/lib/meeting-at-guard";
import { AvatarStreamCard } from "./avatar-stream-card";
import { CandidateStreamCard } from "./candidate-stream-card";
import { InterviewsTablePreview } from "./interviews-table-preview";
import { MeetingHeader } from "./meeting-header";
import { InterviewSummaryDisplay } from "./interview-summary-display";
import { ObserverStreamCard } from "./observer-stream-card";

const HARD_CONTEXT_GUARD_ENABLED = process.env.NEXT_PUBLIC_INTERVIEW_HARD_GUARD === "1";
const SHOW_INTERNAL_DEBUG_UI = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";
const INTERVIEWS_PAGE_SIZE = 8;
const DEFAULT_OBSERVER_CONTROL: ObserverControlState = {
  visibility: "hidden",
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

function sanitizeEntryPath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const candidate = value.trim();
  if (!candidate || candidate === "undefined" || candidate === "null") {
    return "";
  }
  return candidate;
}

function normalizeEntryPath(pathOrUrl: string): string {
  if (!pathOrUrl) {
    return "";
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("/")) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("?")) {
    return `/${pathOrUrl}`;
  }
  return `/${pathOrUrl}`;
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

function extractJobAiIdFromEntryUrl(input: string): number | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const fromPlain = value.match(/[?&]jobAiId=(\d+)/i);
  if (fromPlain) {
    const parsed = Number(fromPlain[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  try {
    const url = new URL(value, "http://localhost");
    const raw = url.searchParams.get("jobAiId");
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
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
    lastInterviewSummary
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
    const direct = normalizeEntryPath(sanitizeEntryPath(selectedRow.candidateEntryPath));
    const base = direct || `/?jobAiId=${encodeURIComponent(selectedRow.jobAiId)}`;
    return withCandidateEntryQuery(base);
  }, [selectedRow]);

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
  const recoveredSessionId =
    sessionId ?? selectedRow?.sessionId ?? selectedInterviewDetailMatched?.projection.sessionId ?? null;
  const recoveredRuntimeActive =
    (selectedRow?.nullxesStatus ?? selectedInterviewDetailMatched?.projection.nullxesStatus) === "in_meeting";
  const selectedNullxesStatus = selectedRow?.nullxesStatus ?? selectedInterviewDetailMatched?.projection.nullxesStatus;
  const selectedJobAiStatus = selectedRow?.jobAiStatus ?? selectedInterviewDetailMatched?.projection.jobAiStatus;
  const completedInterviewLocked = selectedNullxesStatus === "completed" || selectedJobAiStatus === "completed";

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
    const first =
      candidateFio.trim() ||
      selectedRow?.candidateFirstName ||
      selectedInterviewDetailMatched?.interview.candidateFirstName ||
      "";
    const last = selectedRow?.candidateLastName || selectedInterviewDetailMatched?.interview.candidateLastName || "";
    const full = candidateFio.trim() || [first, last].filter(Boolean).join(" ").trim();
    return {
      candidateFirstName: first || undefined,
      candidateLastName: last || undefined,
      candidateFullName: full || undefined,
      jobTitle: selectedInterviewDetailMatched?.interview.jobTitle,
      vacancyText: selectedInterviewDetailMatched?.interview.vacancyText,
      companyName: selectedRow?.companyName || selectedInterviewDetailMatched?.interview.companyName,
      greetingSpeech:
        (selectedInterviewDetailMatched?.interview.greetingSpeechResolved as string | undefined) ??
        selectedInterviewDetailMatched?.interview.greetingSpeech,
      finalSpeech:
        (selectedInterviewDetailMatched?.interview.finalSpeechResolved as string | undefined) ??
        selectedInterviewDetailMatched?.interview.finalSpeech,
      questions: selectedInterviewDetailMatched?.interview.specialty?.questions,
      specialtyName: selectedInterviewDetailMatched?.interview.specialty?.name
    };
  }, [candidateFio, selectedInterviewDetailMatched, selectedRow]);

  useEffect(() => {
    const meetingId = selectedRow?.nullxesMeetingId;
    if (!meetingId || selectedRow?.nullxesStatus !== "completed") {
      setMeetingSummaryFromServer(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getMeetingDetail(meetingId);
        const raw = res.meeting?.metadata?.interviewSummary;
        if (cancelled || !raw || typeof raw !== "object") {
          return;
        }
        setMeetingSummaryFromServer(raw as InterviewSummaryPayload);
      } catch {
        if (!cancelled) {
          setMeetingSummaryFromServer(null);
        }
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
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

      setRows(list.interviews);
      setRowsTotalCount(list.count);
      setSelectedInterviewId((current) => {
        if (requestedInterviewId) {
          return requestedInterviewId;
        }
        if (current && list.interviews.some((item) => item.jobAiId === current)) {
          return current;
        }
        return list.interviews[0]?.jobAiId ?? null;
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

        if (needSync) {
          const syncedDetail = await getInterviewById(selectedInterviewId, true);
          setSelectedInterviewDetail(syncedDetail);
          contextForStart = {
            candidateFirstName: candidateFio.trim() || syncedDetail.interview.candidateFirstName,
            candidateLastName: syncedDetail.interview.candidateLastName,
            candidateFullName:
              candidateFio.trim() ||
              [syncedDetail.interview.candidateFirstName, syncedDetail.interview.candidateLastName]
                .filter(Boolean)
                .join(" ")
                .trim(),
            jobTitle: syncedDetail.interview.jobTitle,
            vacancyText: syncedDetail.interview.vacancyText,
            companyName: syncedDetail.interview.companyName,
            greetingSpeech:
              (syncedDetail.interview.greetingSpeechResolved as string | undefined) ??
              syncedDetail.interview.greetingSpeech,
            finalSpeech:
              (syncedDetail.interview.finalSpeechResolved as string | undefined) ??
              syncedDetail.interview.finalSpeech,
            questions: syncedDetail.interview.specialty?.questions,
            specialtyName: syncedDetail.interview.specialty?.name
          };
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
          statusLabel={statusLabel}
          meetingId={recoveredMeetingId}
          sessionId={recoveredSessionId}
          jobAiId={selectedRow?.jobAiId}
          companyName={selectedRow?.companyName}
          meetingAt={selectedRow?.meetingAt}
          prototypeEntryUrl={
            selectedRow && origin ? toAbsoluteUrl(selectedCandidateEntryPath, origin) : undefined
          }
          onEntryUrlCommit={handleEntryUrlCommit}
          candidateFio={candidateFio}
          onStart={() => {
            void (async () => {
              let contextForStart = interviewStartContext;
              const activeInterviewId = selectedRow?.jobAiId;
              if (
                activeInterviewId &&
                (!selectedInterviewDetailMatched ||
                  !contextForStart?.jobTitle ||
                  !contextForStart?.vacancyText ||
                  !contextForStart?.companyName ||
                  (contextForStart.questions?.length ?? 0) === 0)
              ) {
                try {
                  const syncedDetail = await getInterviewById(activeInterviewId, true);
                  setSelectedInterviewDetail(syncedDetail);
                  contextForStart = {
                    candidateFirstName: candidateFio.trim() || syncedDetail.interview.candidateFirstName,
                    candidateLastName: syncedDetail.interview.candidateLastName,
                    candidateFullName:
                      candidateFio.trim() ||
                      [syncedDetail.interview.candidateFirstName, syncedDetail.interview.candidateLastName]
                        .filter(Boolean)
                        .join(" ")
                        .trim(),
                    jobTitle: syncedDetail.interview.jobTitle,
                    vacancyText: syncedDetail.interview.vacancyText,
                    companyName: syncedDetail.interview.companyName,
                    greetingSpeech:
                      (syncedDetail.interview.greetingSpeechResolved as string | undefined) ??
                      syncedDetail.interview.greetingSpeech,
                    finalSpeech:
                      (syncedDetail.interview.finalSpeechResolved as string | undefined) ??
                      syncedDetail.interview.finalSpeech,
                    questions: syncedDetail.interview.specialty?.questions,
                    specialtyName: syncedDetail.interview.specialty?.name
                  };
                } catch {
                  // Keep best-effort context if force-sync fails.
                }
              }

              await start({
                triggerSource: "manual_start_button",
                interviewId: activeInterviewId,
                meetingAt: selectedRow?.meetingAt,
                interviewContext: contextForStart
              });
            })();
          }}
          onStop={() => {
            void stop({ interviewId: selectedRow?.jobAiId });
          }}
          onFail={markFailed}
          startDisabled={
            phase === "connected" ||
            busy ||
            !selectedRow ||
            completedInterviewLocked ||
            (HARD_CONTEXT_GUARD_ENABLED && !contextHardReady)
          }
          stopDisabled={phase === "idle" || busy}
          failDisabled={phase === "idle" || busy}
          showDebugActions={SHOW_INTERNAL_DEBUG_UI}
        />

        <InterviewSummaryDisplay
          summary={lastInterviewSummary ?? meetingSummaryFromServer}
          title="Итог интервью (саммари)"
        />
        </>
        {isCandidateFlow && candidateWaitingHint ? (
          <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 shadow-sm">
            {candidateWaitingHint}
          </p>
        ) : null}

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
        {(selectedRow || selectedInterviewDetailMatched) && !contextHardReady ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm">
            {HARD_CONTEXT_GUARD_ENABLED
              ? "Start Session заблокирован: для безопасного запуска агента нужны кандидат, должность, текст вакансии, компания и вопросы из JobAI."
              : "Внимание: контекст интервью неполный (кандидат/должность/текст вакансии/компания/вопросы)."}
          </p>
        ) : null}
        {(selectedRow || selectedInterviewDetailMatched) && completedInterviewLocked ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm">
            Эта сессия уже завершена. Повторный старт отключен.
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
          </section>
        ) : null}

        <main className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-3 lg:items-stretch">
          <CandidateStreamCard
            meetingId={recoveredMeetingId}
            sessionId={recoveredSessionId}
            enabled={phase === "connected"}
            autoConnectOnEntry={phase === "connected"}
            participantName={candidateFio.trim() || "Кандидат"}
            interviewId={selectedInterviewId ?? selectedRow?.jobAiId}
            meetingAt={selectedInterviewDetailMatched?.interview.meetingAt ?? selectedRow?.meetingAt}
            interviewContext={interviewStartContext}
            onEnsureInterviewStart={ensureInterviewStart}
            showControls
          />
          <AvatarStreamCard
            participantName="HR ассистент"
            enabled={phase === "connected"}
            avatarReady={avatarReady}
            meetingId={recoveredMeetingId}
            showStreamToolbar={false}
            showStatusBadge
          />
          <ObserverStreamCard
            title="Наблюдатель"
            participantName="Наблюдатель"
            meetingId={recoveredMeetingId}
            enabled={phase === "connected"}
            visible={observerVisible}
            talkMode={observerTalkMode}
            mutePlayback
            allowVisibilityToggle
            allowTalkToggle
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
        </main>
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
        />
        <audio ref={audioRef} autoPlay />
      </div>
    </div>
  );
}
