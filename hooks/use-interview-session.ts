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
  type InterviewDetail,
  type JobAiInterviewStatus
} from "@/lib/api";
import { buildInterviewInstructions, buildOpeningUtterance } from "@/lib/interview-agent-prompt";
import { createAgentContextTrace, type AgentContextTrace } from "@/lib/interview-context-diagnostics";
import { extractCoreFieldsFromInterviewRaw, mergeStartContextWithInterviewDetail } from "@/lib/interview-detail-fields";
import type { InterviewStartContext } from "@/lib/interview-start-context";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { resolveInterviewSummaryPayload } from "@/lib/resolve-interview-summary";
import { WebRtcInterviewClient, type WebRtcConnectionState } from "@/lib/webrtc-client";

export type InterviewPhase = "idle" | "starting" | "connected" | "stopping" | "failed";
export type InterviewStartResult = {
  meetingId: string;
  sessionId: string;
};
export type RuntimeRecoveryState = "idle" | "recovering" | "failed";

export type { InterviewStartContext } from "@/lib/interview-start-context";
export type { AgentContextTrace };

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
/** Повторные попытки восстановления WebRTC после reload (экспоненциальная задержка между попытками). */
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [0, 450, 1400] as const;
/** Интервал опроса готовности аватара до первого ready (после ready таймер останавливается). */
const AVATAR_POLL_MS_ACTIVE = 2000;

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

function mergeInterviewContextForSummary(
  existing: InterviewStartContext | null,
  detail: InterviewDetail
): InterviewStartContext {
  const inv = detail.interview as Record<string, unknown>;
  const ext = extractCoreFieldsFromInterviewRaw(inv);
  const typed = detail.interview;
  const proto = detail.prototypeCandidate;
  const fullFromApi =
    proto?.sourceFullName?.trim() ||
    [typed.candidateFirstName, typed.candidateLastName].filter(Boolean).join(" ").trim();

  const pick = (a: string | undefined, b: string | undefined): string | undefined => {
    const ta = (a ?? "").trim();
    if (ta) {
      return a;
    }
    const tb = (b ?? "").trim();
    return tb ? b : a;
  };

  const mergedQuestions =
    existing?.questions && existing.questions.length > 0 ? existing.questions : typed.specialty?.questions;

  return {
    candidateFirstName: pick(existing?.candidateFirstName, typed.candidateFirstName),
    candidateLastName: pick(existing?.candidateLastName, typed.candidateLastName),
    candidateFullName: pick(existing?.candidateFullName, fullFromApi || undefined),
    jobTitle: pick(existing?.jobTitle, ext.jobTitle),
    vacancyText: pick(existing?.vacancyText, ext.vacancyText),
    companyName: pick(existing?.companyName, ext.companyName),
    specialtyName: pick(existing?.specialtyName, ext.specialtyName ?? typed.specialty?.name),
    greetingSpeech: pick(
      existing?.greetingSpeech,
      (typed.greetingSpeechResolved as string | undefined) ?? typed.greetingSpeech
    ),
    finalSpeech: pick(
      existing?.finalSpeech,
      (typed.finalSpeechResolved as string | undefined) ?? typed.finalSpeech
    ),
    questions: mergedQuestions
  };
}

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

async function postIntroResponseToRtc(
  rtc: WebRtcInterviewClient,
  effectiveContext: InterviewStartContext | undefined
): Promise<void> {
  const runtimeInstructions = buildInterviewInstructions(effectiveContext);
  await rtc.postEvent({
    type: "session.update",
    session: {
      instructions: runtimeInstructions
    }
  });
  const openingUtterance = buildOpeningUtterance(effectiveContext);
  await rtc.postEvent({
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions: [
        "Начни фазу intro ровно один раз.",
        "Произнеси ДОСЛОВНО следующий блок (сохраняй переносы строк), без перефразирования и без повторов.",
        "После этого остановись и дождись ответа кандидата согласно сценарию приветствия (готовность, согласие с записью и т.д.).",
        "Не называй себя именем кандидата.",
        "",
        "---",
        openingUtterance,
        "---"
      ].join("\n")
    }
  });
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
  const avatarPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
      if (avatarPollTimerRef.current) {
        clearInterval(avatarPollTimerRef.current);
        avatarPollTimerRef.current = null;
      }
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
          if (isReady && avatarPollTimerRef.current) {
            clearInterval(avatarPollTimerRef.current);
            avatarPollTimerRef.current = null;
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        // Gateway без GET /realtime/session/:id отдаёт 404 — это не «аватар мёртв», а отсутствие телеметрии.
        if (error instanceof ApiRequestError && error.status === 404) {
          console.warn(
            "[interview] getRealtimeSessionState: upstream 404 — на gateway нет GET /realtime/session/:id; опрос avatar_ready отключён, WebRTC не страдает."
          );
          setAvatarReady(true);
          if (avatarPollTimerRef.current) {
            clearInterval(avatarPollTimerRef.current);
            avatarPollTimerRef.current = null;
          }
          return;
        }
        setAvatarReady(false);
      }
    };

    void checkAvatarReady();
    if (avatarPollTimerRef.current) {
      clearInterval(avatarPollTimerRef.current);
    }
    avatarPollTimerRef.current = setInterval(() => {
      void checkAvatarReady();
    }, AVATAR_POLL_MS_ACTIVE);

    return () => {
      cancelled = true;
      if (avatarPollTimerRef.current) {
        clearInterval(avatarPollTimerRef.current);
        avatarPollTimerRef.current = null;
      }
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
      let lastError: unknown;
      for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
        if (cancelled) {
          return;
        }
        if (attempt > 0) {
          const delay = RECONNECT_BACKOFF_MS[attempt] ?? 500;
          await new Promise((r) => setTimeout(r, delay));
        }
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

            /**
             * Кандидат по ссылке: `hydrateActiveSession` подставляет sessionId из projection, затем
             * этот эффект вызывает `connect()` и получает **новую** Realtime-сессию. Без повторного
             * `response.create` агент молчит (приветствие ушло только в старую сессию HR).
             */
            try {
              if (!cancelled) {
                const freshDetail = await getInterviewById(activeInterviewId, true);
                const effectiveContext = mergeStartContextWithInterviewDetail(
                  lastInterviewContextRef.current ?? undefined,
                  freshDetail
                );
                lastInterviewContextRef.current = effectiveContext;
                const requiredContext = evaluateRequiredContext(effectiveContext);
                const contextOk =
                  !HARD_CONTEXT_GUARD_ENABLED ||
                  (requiredContext.candidateReady &&
                    requiredContext.companyReady &&
                    requiredContext.jobTitleReady &&
                    requiredContext.vacancyTextReady &&
                    requiredContext.questionsReady);
                if (contextOk && rtc.getSessionId() === connected.sessionId && !cancelled) {
                  setLastAgentContextTrace(
                    createAgentContextTrace(effectiveContext, freshDetail, {
                      meetingId,
                      sessionId: connected.sessionId,
                      interviewId: activeInterviewId,
                      stage: "reconnect:after_merge",
                      triggerSource: "webrtc_restore"
                    })
                  );
                  await postIntroResponseToRtc(rtc, effectiveContext);
                }
              }
            } catch (introErr) {
              console.warn("[interview] WebRTC restore: intro replay failed", introErr);
            }
          }
          reconnectAttemptForSessionRef.current = null;
          setRuntimeRecoveryState("idle");
          return;
        } catch (restoreError) {
          lastError = restoreError;
        }
      }
      if (cancelled) {
        return;
      }
      setRuntimeRecoveryState("failed");
      setError(
        lastError instanceof Error
          ? `Не удалось восстановить runtime после обновления страницы (${RECONNECT_ATTEMPTS} попыток): ${lastError.message}`
          : `Не удалось восстановить runtime после обновления страницы (${RECONNECT_ATTEMPTS} попыток).`
      );
    };

    void restoreRuntime();
    return () => {
      cancelled = true;
    };
  }, [activeInterviewId, ensureClient, meetingId, phase, runtimeRecoveryState, sessionId]);

  const start = useCallback(async (options?: StartOptions): Promise<InterviewStartResult> => {
    if (phase === "connected" && meetingId && sessionId) {
      const interviewIdForContext = options?.interviewId;
      if (
        typeof interviewIdForContext === "number" &&
        (options?.triggerSource === "join_stream" || Boolean(options?.interviewContext))
      ) {
        const rtc = rtcRef.current;
        if (rtc?.getSessionId() === sessionId) {
          let effectiveContext: InterviewStartContext | undefined = options?.interviewContext;
          let syncDetail: InterviewDetail | undefined;
          try {
            const freshDetail = await getInterviewById(interviewIdForContext, true);
            syncDetail = freshDetail;
            effectiveContext = mergeStartContextWithInterviewDetail(effectiveContext, freshDetail);
          } catch {
            /* keep passed UI context */
          }
          const requiredContext = evaluateRequiredContext(effectiveContext);
          const contextOk =
            !HARD_CONTEXT_GUARD_ENABLED ||
            (requiredContext.candidateReady &&
              requiredContext.companyReady &&
              requiredContext.jobTitleReady &&
              requiredContext.vacancyTextReady &&
              requiredContext.questionsReady);
          if (contextOk && effectiveContext) {
            try {
              lastInterviewContextRef.current = effectiveContext;
              const runtimeInstructions = buildInterviewInstructions(effectiveContext);
              setLastAgentContextTrace(
                createAgentContextTrace(effectiveContext, syncDetail, {
                  meetingId,
                  sessionId,
                  interviewId: interviewIdForContext,
                  stage: "start:session_update_connected",
                  triggerSource: options?.triggerSource
                })
              );
              await rtc.postEvent({
                type: "session.update",
                session: {
                  instructions: runtimeInstructions
                }
              });
            } catch {
              /* best-effort: stream join must not fail if context sync misses */
            }
          }
        }
      }
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

    let effectiveContext: InterviewStartContext | undefined = options?.interviewContext;
    let detailAfterFetch: InterviewDetail | undefined;
    if (options?.interviewId) {
      try {
        const freshDetail = await getInterviewById(options.interviewId, true);
        detailAfterFetch = freshDetail;
        effectiveContext = mergeStartContextWithInterviewDetail(effectiveContext, freshDetail);
      } catch {
        /* оставляем контекст с UI; без сети старт всё равно может быть нужен для отладки */
      }
    }

    const requiredContext = evaluateRequiredContext(effectiveContext);
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
          interviewContext: effectiveContext,
          interviewContextMeta: {
            contextVersion: "INTERVIEW_UI_CONTRACT_v2",
            hardContextGuardEnabled: HARD_CONTEXT_GUARD_ENABLED,
            hasCandidateName: requiredContext.candidateReady,
            hasJobTitle: Boolean(effectiveContext?.jobTitle),
            hasVacancyText: Boolean(effectiveContext?.vacancyText),
            hasCompanyName: Boolean(effectiveContext?.companyName),
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

      lastInterviewContextRef.current = effectiveContext ?? null;
      setLastAgentContextTrace(
        createAgentContextTrace(effectiveContext, detailAfterFetch, {
          meetingId: internalMeetingId,
          sessionId: connected.sessionId,
          interviewId: options?.interviewId,
          stage: "start:after_merge",
          triggerSource
        })
      );
      await postIntroResponseToRtc(rtc, effectiveContext);

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

      let summaryInput: InterviewStartContext | null = lastInterviewContextRef.current;
      const interviewIdForSummary = options?.interviewId ?? activeInterviewId ?? undefined;
      if (interviewIdForSummary) {
        try {
          const detail = await getInterviewById(interviewIdForSummary, true);
          summaryInput = mergeInterviewContextForSummary(summaryInput, detail);
        } catch {
          // Оставляем контекст из памяти сессии (например, офлайн gateway).
        }
      }

      const summaryPayload = await resolveInterviewSummaryPayload(summaryInput);
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
