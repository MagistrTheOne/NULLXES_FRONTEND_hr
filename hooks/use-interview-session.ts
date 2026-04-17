"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  closeRealtimeSession,
  failMeeting,
  getRealtimeSessionState,
  getInterviewById,
  linkInterviewSession,
  sendRealtimeEvent,
  startMeeting,
  stopMeeting,
  updateInterviewStatus,
  type JobAiInterviewStatus
} from "@/lib/api";
import {
  buildInterviewSummaryPayload,
  truncateVacancyForContext,
  type InterviewSummaryPayload
} from "@/lib/interview-summary";
import { WebRtcInterviewClient, type WebRtcConnectionState } from "@/lib/webrtc-client";

export type InterviewPhase = "idle" | "starting" | "connected" | "stopping" | "failed";
export type InterviewStartResult = {
  meetingId: string;
  sessionId: string;
};
export type RuntimeRecoveryState = "idle" | "recovering" | "failed";

export type InterviewStartContext = {
  candidateFirstName?: string;
  candidateLastName?: string;
  candidateFullName?: string;
  jobTitle?: string;
  vacancyText?: string;
  companyName?: string;
  /** Название специальности из JobAI (specialty.name) */
  specialtyName?: string;
  greetingSpeech?: string;
  finalSpeech?: string;
  questions?: Array<{ text: string; order: number }>;
};

export type AgentContextTrace = {
  sentAt: string;
  interviewId?: number;
  meetingId: string;
  sessionId: string;
  candidateFullName?: string;
  companyName?: string;
  jobTitle?: string;
  questionsCount: number;
};

type StartOptions = {
  triggerSource?: string;
  interviewId?: number;
  meetingAt?: string;
  bypassMeetingAtGuard?: boolean;
  interviewContext?: InterviewStartContext;
};

const AVATAR_READY_EVENT_TYPES = [
  "avatar_ready",
  "avatar.ready",
  "agent.avatar.ready",
  "avatar.stream.joined"
];
const HARD_CONTEXT_GUARD_ENABLED = process.env.NEXT_PUBLIC_INTERVIEW_HARD_GUARD === "1";
const AGENT_SELF_INTRO = "Я HR-ассистент и готов провести с вами собеседование.";

function isIgnorableStatusTransitionError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.status === 409;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("interviews.status_change_not_allowed");
}

function canBypassMeetingAtGuard(options?: StartOptions): boolean {
  const source = options?.triggerSource ?? "";
  if (source === "manual_start_button") {
    return true;
  }
  if (source === "candidate_auto_start") {
    if (!options?.meetingAt) {
      return false;
    }
    const meetingTimestamp = new Date(options.meetingAt).getTime();
    return Number.isFinite(meetingTimestamp) && Date.now() >= meetingTimestamp;
  }
  if (!options?.bypassMeetingAtGuard) {
    return false;
  }
  return source.startsWith("debug_");
}

function formatMeetingAtGuardMessage(meetingAt: string): string {
  const timestamp = new Date(meetingAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return "Собеседование пока нельзя запускать: некорректно задано meetingAt.";
  }
  const localized = new Date(timestamp).toLocaleString("ru-RU");
  return `Собеседование можно запустить только после ${localized}.`;
}

type RequiredContextCheck = {
  candidateReady: boolean;
  companyReady: boolean;
  jobTitleReady: boolean;
  vacancyTextReady: boolean;
  questionsReady: boolean;
  questionsCount: number;
};

function evaluateRequiredContext(context?: InterviewStartContext): RequiredContextCheck {
  const candidateReady = Boolean(
    context?.candidateFullName?.trim() ||
      context?.candidateFirstName?.trim() ||
      context?.candidateLastName?.trim()
  );
  const companyReady = Boolean(context?.companyName?.trim());
  const jobTitleReady = Boolean(context?.jobTitle?.trim());
  const vacancyTextReady = Boolean(context?.vacancyText?.trim());
  const questionsCount = context?.questions?.length ?? 0;
  const questionsReady = questionsCount > 0;

  return {
    candidateReady,
    companyReady,
    jobTitleReady,
    vacancyTextReady,
    questionsReady,
    questionsCount
  };
}

function buildInterviewInstructions(context?: InterviewStartContext): string {
  const candidateFullName =
    context?.candidateFullName?.trim() ||
    [context?.candidateFirstName?.trim(), context?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "кандидат";
  const company = context?.companyName?.trim() || "компания не указана";
  const jobTitle = context?.jobTitle?.trim() || "должность не указана";
  const specialtyName = context?.specialtyName?.trim();
  const { text: vacancyForModel, truncated: vacancyWasTruncated } = truncateVacancyForContext(context?.vacancyText);
  const greeting =
    context?.greetingSpeech?.trim() ||
    `Здравствуйте, ${candidateFullName}. Это интервью на позицию ${jobTitle} в компанию ${company}. Вы готовы пройти интервью?`;
  const finalSpeech = context?.finalSpeech?.trim() || "Спасибо за интервью.";
  const questions = (context?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q, idx) => `${idx + 1}. [order=${q.order}] ${q.text}`)
    .join("\n");

  const phaseProtocol = [
    "СТРОГИЙ СЦЕНАРИЙ ИЗ 4 ФАЗ (не пропускай и не меняй порядок):",
    "1) intro — один раз представься как HR-ассистент одной фразой (используй дословно эту фразу для самопрезентации: «" +
      AGENT_SELF_INTRO +
      "»). Сразу после неё произнеси приветствие из блока «Приветствие» ниже дословно и задай вопрос «Вы готовы пройти интервью?». Дождись явного ответа кандидата.",
    "2) questions — задавай вопросы строго по списку ниже, по возрастанию order. После каждого вопроса дождись ответа; не переходи к следующему, пока кандидат не ответил или явно откажется.",
    "3) closing — когда все вопросы пройдены или кандидат завершил, произнеси финальную фразу из блока «Финальная фраза» дословно.",
    "4) summary — кратко (устно, 30–60 секунд) резюмируй впечатление по вакансии и ответам; не выдумывай факты вне контекста. Затем попрощайся.",
    "Правило: не повторяй самопрезентацию и полное приветствие повторно во время сессии."
  ].join("\n");

  return [
    "Ты HR-аватар для технического интервью.",
    "Никогда не представляйся именем кандидата и не говори о себе как о кандидате.",
    "Ты представитель интервьюера (HR-аватар), кандидат — отдельный человек из контекста.",
    "Используй только контекст ниже; не придумывай новые факты и не меняй компанию/должность/имя кандидата.",
    "Если кандидат спрашивает «по какому собеседованию мы проводимся?», отвечай строго: должность + компания + имя кандидата.",
    phaseProtocol,
    `Кандидат: ${candidateFullName}`,
    `Компания: ${company}`,
    `Должность: ${jobTitle}`,
    specialtyName ? `Специальность: ${specialtyName}` : "",
    vacancyForModel ? `Описание вакансии:\n${vacancyForModel}` : "Описание вакансии: не предоставлено",
    vacancyWasTruncated ? "Примечание: описание вакансии могло быть сокращено для лимита контекста — не дополняй выдуманными деталями." : "",
    questions ? `Вопросы для интервью (порядок = order):\n${questions}` : "Вопросы для интервью: не предоставлены",
    `Приветствие (фаза intro, дословно после самопрезентации): ${greeting}`,
    `Финальная фраза (фаза closing, дословно): ${finalSpeech}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildOpeningUtterance(context?: InterviewStartContext): string {
  const candidateFullName =
    context?.candidateFullName?.trim() ||
    [context?.candidateFirstName?.trim(), context?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "кандидат";
  const company = context?.companyName?.trim() || "компания не указана";
  const jobTitle = context?.jobTitle?.trim() || "должность не указана";
  const greeting = context?.greetingSpeech?.trim() || `Это собеседование по вакансии ${jobTitle} в компанию ${company}.`;
  /** Одна связка: самопрезентация + приветствие + вопрос готовности (без дублирования в других событиях). */
  return `${AGENT_SELF_INTRO} Здравствуйте, ${candidateFullName}. ${greeting} Вы готовы пройти интервью?`;
}

async function transitionJobAiToInMeeting(interviewId: number): Promise<void> {
  const detail = await getInterviewById(interviewId).catch(() => null);
  const currentStatus = (detail?.projection.jobAiStatus ?? detail?.interview.status) as JobAiInterviewStatus | undefined;

  if (!currentStatus) {
    return;
  }
  if (currentStatus === "in_meeting") {
    return;
  }
  if (currentStatus === "pending") {
    await updateInterviewStatus(interviewId, "received");
    await updateInterviewStatus(interviewId, "in_meeting");
    return;
  }
  if (currentStatus === "received") {
    await updateInterviewStatus(interviewId, "in_meeting");
  }
}

async function transitionJobAiToCompleted(interviewId: number): Promise<void> {
  const detail = await getInterviewById(interviewId).catch(() => null);
  const currentStatus = (detail?.projection.jobAiStatus ?? detail?.interview.status) as JobAiInterviewStatus | undefined;

  if (!currentStatus || currentStatus === "completed") {
    return;
  }

  if (currentStatus === "pending") {
    await updateInterviewStatus(interviewId, "received");
    await updateInterviewStatus(interviewId, "in_meeting");
    await updateInterviewStatus(interviewId, "completed");
    return;
  }
  if (currentStatus === "received") {
    await updateInterviewStatus(interviewId, "in_meeting");
    await updateInterviewStatus(interviewId, "completed");
    return;
  }
  if (currentStatus === "in_meeting") {
    await updateInterviewStatus(interviewId, "completed");
  }
}

export function useInterviewSession() {
  const [phase, setPhase] = useState<InterviewPhase>("idle");
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const [lastAgentContextTrace, setLastAgentContextTrace] = useState<AgentContextTrace | null>(null);
  const [rtcState, setRtcState] = useState<WebRtcConnectionState>("idle");
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
  const [agentInputEnabled, setAgentInputEnabled] = useState(true);
  const [runtimeRecoveryState, setRuntimeRecoveryState] = useState<RuntimeRecoveryState>("idle");
  const [activeInterviewId, setActiveInterviewId] = useState<number | null>(null);
  const [lastInterviewSummary, setLastInterviewSummary] = useState<InterviewSummaryPayload | null>(null);

  const rtcRef = useRef<WebRtcInterviewClient | null>(null);
  const reconnectAttemptForSessionRef = useRef<string | null>(null);
  const lastInterviewContextRef = useRef<InterviewStartContext | null>(null);

  const ensureClient = useCallback(() => {
    if (!rtcRef.current) {
      rtcRef.current = new WebRtcInterviewClient({
        onStateChange: setRtcState,
        onRemoteStream: setRemoteAudioStream
      });
    }
    return rtcRef.current;
  }, []);

  const hydrateActiveSession = useCallback((next: { meetingId: string; sessionId: string; interviewId?: number }) => {
    setMeetingId((current) => current ?? next.meetingId);
    setSessionId((current) => current ?? next.sessionId);
    setActiveInterviewId((current) => current ?? next.interviewId ?? null);
    setPhase((current) => (current === "idle" ? "connected" : current));
  }, []);

  const setObserverTalkIsolation = useCallback(
    async (observerTalkActive: boolean) => {
      const rtc = ensureClient();
      const nextAgentInputEnabled = !observerTalkActive;
      rtc.setAudioInputEnabled(nextAgentInputEnabled);
      setAgentInputEnabled(nextAgentInputEnabled);

      const activeSessionId = rtc.getSessionId();
      if (!activeSessionId) {
        return;
      }
      try {
        await rtc.postEvent({
          type: "observer.agent_isolation.enforced",
          observerTalkActive,
          agentInputEnabled: nextAgentInputEnabled
        });
      } catch {
        // Ignore telemetry delivery errors; isolation is enforced locally.
      }
    },
    [ensureClient]
  );

  useEffect(() => {
    if (!sessionId || phase !== "connected") {
      queueMicrotask(() => {
        setAvatarReady(false);
      });
      return;
    }

    let cancelled = false;

    const checkAvatarReady = async () => {
      try {
        const state = await getRealtimeSessionState(sessionId);
        const counts = state.session.eventTypeCounts ?? {};
        const isReady = AVATAR_READY_EVENT_TYPES.some((type) => (counts[type] ?? 0) > 0);
        if (!cancelled) {
          setAvatarReady(isReady);
        }
      } catch {
        if (!cancelled) {
          setAvatarReady(false);
        }
      }
    };

    void checkAvatarReady();
    const timer = setInterval(() => {
      void checkAvatarReady();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, sessionId]);

  useEffect(() => {
    if (phase !== "connected" || !meetingId || !sessionId) {
      reconnectAttemptForSessionRef.current = null;
      if (runtimeRecoveryState !== "idle") {
        queueMicrotask(() => {
          setRuntimeRecoveryState("idle");
        });
      }
      return;
    }

    const rtc = ensureClient();
    if (rtc.getState() === "connected" && rtc.getSessionId()) {
      if (runtimeRecoveryState !== "idle") {
        queueMicrotask(() => {
          setRuntimeRecoveryState("idle");
        });
      }
      return;
    }

    if (reconnectAttemptForSessionRef.current === sessionId) {
      return;
    }
    reconnectAttemptForSessionRef.current = sessionId;

    let cancelled = false;
    const restoreRuntime = async () => {
      setRuntimeRecoveryState("recovering");
      try {
        const connected = await rtc.connect();
        if (cancelled) {
          rtc.close();
          return;
        }
        setSessionId(connected.sessionId);
        if (activeInterviewId) {
          await linkInterviewSession({
            interviewId: activeInterviewId,
            meetingId,
            sessionId: connected.sessionId,
            nullxesStatus: "in_meeting"
          }).catch(() => undefined);
        }
        setRuntimeRecoveryState("idle");
      } catch (restoreError) {
        if (cancelled) {
          return;
        }
        setRuntimeRecoveryState("failed");
        setError(
          restoreError instanceof Error
            ? `Не удалось восстановить runtime после обновления страницы: ${restoreError.message}`
            : "Не удалось восстановить runtime после обновления страницы."
        );
      }
    };

    void restoreRuntime();
    return () => {
      cancelled = true;
    };
  }, [activeInterviewId, ensureClient, meetingId, phase, runtimeRecoveryState, sessionId]);

  const start = useCallback(async (options?: StartOptions): Promise<InterviewStartResult> => {
    if (phase === "connected" && meetingId && sessionId) {
      return { meetingId, sessionId };
    }
    if (phase === "starting") {
      throw new Error("Interview session is already starting");
    }

    const internalMeetingId = `meeting-${Date.now()}`;
    const triggerSource = options?.triggerSource ?? "frontend_manual";

    if (options?.meetingAt && !canBypassMeetingAtGuard(options)) {
      const meetingTimestamp = new Date(options.meetingAt).getTime();
      if (Number.isFinite(meetingTimestamp) && Date.now() < meetingTimestamp) {
        throw new Error(formatMeetingAtGuardMessage(options.meetingAt));
      }
    }

    const requiredContext = evaluateRequiredContext(options?.interviewContext);
    if (
      HARD_CONTEXT_GUARD_ENABLED &&
      (!requiredContext.candidateReady ||
        !requiredContext.companyReady ||
        !requiredContext.jobTitleReady ||
        !requiredContext.vacancyTextReady ||
        !requiredContext.questionsReady)
    ) {
      throw new Error(
        "Start Session blocked: interview context is incomplete (candidate, company, job title, vacancy text, questions)."
      );
    }

    setPhase("starting");
    setError(null);
    setRuntimeRecoveryState("idle");
    setLastInterviewSummary(null);

    try {
      await startMeeting({
        internalMeetingId,
        triggerSource,
        metadata: {
          source: "jobaidemo",
          jobAiInterviewId: options?.interviewId,
          interviewContext: options?.interviewContext,
          interviewContextMeta: {
            contextVersion: "INTERVIEW_UI_CONTRACT_v1",
            hardContextGuardEnabled: HARD_CONTEXT_GUARD_ENABLED,
            hasCandidateName: requiredContext.candidateReady,
            hasJobTitle: Boolean(options?.interviewContext?.jobTitle),
            hasVacancyText: Boolean(options?.interviewContext?.vacancyText),
            hasCompanyName: Boolean(options?.interviewContext?.companyName),
            questionCount: requiredContext.questionsCount
          }
        }
      });
      setMeetingId(internalMeetingId);
      setActiveInterviewId(options?.interviewId ?? null);

      const rtc = ensureClient();
      const connected = await rtc.connect();
      setSessionId(connected.sessionId);

      if (options?.interviewId) {
        await linkInterviewSession({
          interviewId: options.interviewId,
          meetingId: internalMeetingId,
          sessionId: connected.sessionId,
          nullxesStatus: "in_meeting"
        });
        try {
          await transitionJobAiToInMeeting(options.interviewId);
        } catch (statusError) {
          if (isIgnorableStatusTransitionError(statusError)) {
            console.warn("Skipping non-critical JobAI status transition error", statusError);
          } else {
            setError(statusError instanceof Error ? statusError.message : "Failed to update JobAI status");
          }
        }
      }

      lastInterviewContextRef.current = options?.interviewContext ?? null;
      const runtimeInstructions = buildInterviewInstructions(options?.interviewContext);
      setLastAgentContextTrace({
        sentAt: new Date().toISOString(),
        interviewId: options?.interviewId,
        meetingId: internalMeetingId,
        sessionId: connected.sessionId,
        candidateFullName:
          options?.interviewContext?.candidateFullName ||
          [options?.interviewContext?.candidateFirstName, options?.interviewContext?.candidateLastName]
            .filter(Boolean)
            .join(" ")
            .trim(),
        companyName: options?.interviewContext?.companyName,
        jobTitle: options?.interviewContext?.jobTitle,
        questionsCount: options?.interviewContext?.questions?.length ?? 0
      });
      await rtc.postEvent({
        type: "session.update",
        session: {
          instructions: runtimeInstructions
        }
      });
      const openingUtterance = buildOpeningUtterance(options?.interviewContext);
      await rtc.postEvent({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Начни фазу intro ровно один раз: произнеси вслух следующую фразу целиком, без повторов и без перефразирования: "${openingUtterance}". После этого остановись и дождись ответа кандидата на вопрос о готовности. Не называй себя именем кандидата.`
        }
      });

      setPhase("connected");
      setRuntimeRecoveryState("idle");
      return {
        meetingId: internalMeetingId,
        sessionId: connected.sessionId
      };
    } catch (err) {
      setPhase("failed");
      const startError = err instanceof Error ? err : new Error("Failed to start session");
      setError(startError.message);
      if (internalMeetingId) {
        try {
          await failMeeting(internalMeetingId, {
            status: "failed_connect_ws_audio",
            reason: "frontend_start_failed"
          });
        } catch {
          // Ignore secondary fail-notification errors in prototype.
        }
      }
      throw startError;
    }
  }, [ensureClient, meetingId, phase, sessionId]);

  const stop = useCallback(async (options?: { interviewId?: number }) => {
    if (!meetingId) {
      return;
    }

    setPhase("stopping");
    setRuntimeRecoveryState("idle");
    try {
      const activeMeetingId = meetingId;
      const activeSessionId = sessionId;
      const rtc = rtcRef.current;
      const summaryPayload = buildInterviewSummaryPayload(lastInterviewContextRef.current);
      setLastInterviewSummary(summaryPayload);

      if (activeSessionId) {
        await sendRealtimeEvent(activeSessionId, {
          type: "interview.summary.generated",
          schemaVersion: "1.0",
          source: "jobaidemo",
          summarySchemaVersion: summaryPayload.summarySchemaVersion,
          summary: summaryPayload
        }).catch(() => undefined);
      }

      if (rtc?.getSessionId()) {
        await rtc.postEvent({
          type: "session.update",
          source: "frontend",
          message: "session_stopping"
        });
      }

      await stopMeeting(activeMeetingId, {
        reason: "manual_stop",
        finalStatus: "completed",
        metadata: {
          interviewSummary: summaryPayload,
          jobAiInterviewId: options?.interviewId ?? activeInterviewId ?? undefined
        }
      });

      const interviewIdForClose = options?.interviewId ?? activeInterviewId ?? undefined;
      if (interviewIdForClose) {
        try {
          await transitionJobAiToCompleted(interviewIdForClose);
        } catch (statusError) {
          if (isIgnorableStatusTransitionError(statusError)) {
            console.warn("Skipping non-critical JobAI status transition error", statusError);
          } else {
            setError(statusError instanceof Error ? statusError.message : "Failed to update JobAI status");
          }
        }
        try {
          await linkInterviewSession({
            interviewId: interviewIdForClose,
            meetingId: activeMeetingId,
            sessionId: activeSessionId ?? undefined,
            nullxesStatus: "completed"
          });
        } catch (statusError) {
          if (isIgnorableStatusTransitionError(statusError)) {
            console.warn("Skipping non-critical JobAI status transition error", statusError);
          } else {
            setError(statusError instanceof Error ? statusError.message : "Failed to update JobAI status");
          }
        }
      }
      rtc?.close();
      if (activeSessionId) {
        await closeRealtimeSession(activeSessionId).catch(() => undefined);
      }
      setMeetingId(null);
      setSessionId(null);
      setActiveInterviewId(null);
      lastInterviewContextRef.current = null;
      setAvatarReady(false);
      setAgentInputEnabled(true);
      setPhase("idle");
    } catch (err) {
      setPhase("failed");
      setError(err instanceof Error ? err.message : "Failed to stop session");
    }
  }, [activeInterviewId, meetingId, sessionId]);

  const markFailed = useCallback(async () => {
    if (!meetingId) {
      return;
    }
    await failMeeting(meetingId, {
      status: "failed_connect_ws_audio",
      reason: "manual_mark_failed"
    });
    setRuntimeRecoveryState("idle");
    setPhase("failed");
  }, [meetingId]);

  const statusLabel = useMemo(() => {
    if (runtimeRecoveryState === "recovering") return "Recovering runtime";
    if (phase === "idle") return "Idle";
    if (phase === "starting") return "Starting";
    if (phase === "connected") return "Connected";
    if (phase === "stopping") return "Stopping";
    return "Failed";
  }, [phase, runtimeRecoveryState]);

  return {
    phase,
    statusLabel,
    meetingId,
    sessionId,
    avatarReady,
    lastInterviewSummary,
    lastAgentContextTrace,
    rtcState,
    error,
    remoteAudioStream,
    agentInputEnabled,
    runtimeRecoveryState,
    start,
    stop,
    markFailed,
    setObserverTalkIsolation,
    hydrateActiveSession
  };
}
