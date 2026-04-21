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
import { WebRtcInterviewClient, type OpenAiServerEvent, type WebRtcConnectionState } from "@/lib/webrtc-client";

export type InterviewPhase = "idle" | "starting" | "connected" | "stopping" | "failed";
export type InterviewStartResult = {
  meetingId: string;
  sessionId: string;
};
export type RuntimeRecoveryState = "idle" | "recovering" | "failed";

/**
 * Внутренняя модель прогресса интервью — производная от потока событий
 * OpenAI Realtime. Используется для phase indicator и thank-you screen.
 *
 *  - "lobby"      — соединение ещё не установлено / ожидание
 *  - "intro"      — агент произносит greeting (первая response.created)
 *  - "questions"  — greeting закончен, идёт цикл вопросов
 *  - "closing"    — meeting status перешёл в completed (финальный экран)
 *  - "completed"  — всё закрыто, можно показывать thank-you
 */
export type InterviewFlowPhase = "lobby" | "intro" | "questions" | "closing" | "completed";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export type TranscriptTurn = {
  role: "agent" | "candidate";
  text: string;
  ts: number;
  itemId?: string;
};

export type LiveCaptions = {
  agent?: string;
  candidate?: string;
};

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

/**
 * Best-effort field reader for arbitrary OpenAI server-event payloads. Realtime
 * responses use slightly different shapes between snapshots — we just want a
 * string if it exists, never throw on weird input.
 */
function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

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

type IntroMode = "first" | "reconnect";

async function postIntroResponseToRtc(
  rtc: WebRtcInterviewClient,
  effectiveContext: InterviewStartContext | undefined,
  mode: IntroMode = "first"
): Promise<void> {
  const runtimeInstructions = buildInterviewInstructions(effectiveContext);
  // OpenAI Realtime GA requires session.type to be set on every session.update.
  // Without it the API silently rejects the update and our instructions never
  // reach the model, leaving the agent stuck on default behaviour.
  //
  // ВАЖНО — НЕ трогать состав этого `session.update`. Минимальный рабочий
  // набор для GA endpoint это ровно `{ type: "realtime", instructions }`.
  // Любая попытка добавить `turn_detection` (даже с только тремя core VAD
  // полями, без create_response/interrupt_response) приводит к тому, что
  // endpoint молча отклоняет ВЕСЬ update (в консоли видны 2 `[OpenAI
  // Realtime] error` сразу после `session.updated`), и `instructions` в
  // том же payload тоже теряются. Модель остаётся на дефолтном промпте и
  // здоровается «Здравствуйте, чем могу помочь?» вместо JobAI-интро.
  //
  // Если понадобится тюнинг VAD для шумозащиты — делать это нужно в
  // initial session config на backend (openaiRealtimeClient POST
  // /v1/realtime/calls, multipart `session`), а не через runtime update.
  await rtc.postEvent({
    type: "session.update",
    session: {
      type: "realtime",
      instructions: runtimeInstructions
    }
  });

  // Короткая пауза между session.update и response.create. Без неё на GA
  // endpoint агент иногда ждёт первого `input_audio` от кандидата перед тем
  // как озвучить intro — потому что `response.create` прилетает раньше, чем
  // сервер подтвердил `session.updated`, и уходит в конец очереди. 800мс
  // достаточно чтобы session.updated долетел в 99% случаев, но визуально
  // почти неощутимо для пользователя (по ТЗ клиента: «сразу или 1–2 сек»).
  await new Promise((resolve) => setTimeout(resolve, 800));

  const openingUtterance = buildOpeningUtterance(effectiveContext, mode);
  const hasGreetingSpeech = Boolean(effectiveContext?.greetingSpeech?.trim());

  const baseInstructions =
    mode === "reconnect"
      ? [
          "КОНТЕКСТ: WebRTC-сессия была восстановлена. Кандидат уже слышал полное приветствие ранее.",
          "ЗАДАЧА: произнеси короткий мост между маркерами «---» ДОСЛОВНО (одна-две фразы).",
          "Запрещено: повторять полное приветствие JobAI заново, говорить «Добрый день» во второй раз, рассказывать про запись повторно, начинать интервью с нуля.",
          "После последней строки блока — продолжай интервью с того order, на котором остановились (если уже шла фаза questions). Если кандидат ещё не подтвердил готовность — короткой фразой переспроси готовность."
        ]
      : [
          "ЗАДАЧА: озвучить фазу intro ровно один раз — это твоя ПЕРВАЯ реплика.",
          "Озвучь блок между маркерами «---» ДОСЛОВНО, без перестановки предложений, без сокращений, без перефразирования и без добавления своих фраз.",
          "Сохрани все факты из блока: представление как HR аватара указанной компании, имя кандидата, название вакансии и любое упоминание записи и согласия, если они есть.",
          "Запрещено: говорить «давайте начнём собеседование» вместо текста блока, опускать упоминание записи, заменять «Добрый день» на «Здравствуйте», добавлять «Я бот» / «Я ИИ» от себя.",
          hasGreetingSpeech
            ? "Источник истины приветствия — JobAI; внутри блока приветствие из JobAI идёт ПОСЛЕ строки самопрезентации, произнеси его целиком."
            : "В этом интервью кастомный текст приветствия не задан — используй блок ниже как есть.",
          "После последней строки блока остановись и дождись ответа кандидата (готовность / согласие). Не задавай больше одного финального вопроса.",
          "Не называй себя именем кандидата."
        ];

  await rtc.postEvent({
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions: [
        ...baseInstructions,
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

  // Phase indicator (B), agent state (C), live captions (F.3)
  const [flowPhase, setFlowPhase] = useState<InterviewFlowPhase>("lobby");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [latestCaptions, setLatestCaptions] = useState<LiveCaptions>({});
  /**
   * Reactive mirror of `transcriptsRef.current` — identical data, but state so
   * the HR insight panel can re-render when new turns arrive. We push to BOTH
   * the ref (used by stop() flush / post-meeting summary pipeline) and this
   * state (consumed by UI). Kept as a ref-shaped array, not a Map, because
   * transcript order is meaningful.
   */
  const [transcripts, setTranscripts] = useState<TranscriptTurn[]>([]);

  const rtcRef = useRef<WebRtcInterviewClient | null>(null);
  const reconnectAttemptForSessionRef = useRef<string | null>(null);
  const avatarPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastInterviewContextRef = useRef<InterviewStartContext | null>(null);

  // Transcript collection (F.2). We use refs so accumulation does not trigger
  // re-renders on every audio-transcript delta — only the captions state does.
  const transcriptsRef = useRef<TranscriptTurn[]>([]);
  const agentTranscriptBufferRef = useRef<Map<string, string>>(new Map());
  const greetingDoneRef = useRef(false);
  const lastResponseIdRef = useRef<string | null>(null);
  const captionFadeTimerRef = useRef<{ agent: ReturnType<typeof setTimeout> | null; candidate: ReturnType<typeof setTimeout> | null }>({
    agent: null,
    candidate: null
  });

  /**
   * Reducer over the OpenAI Realtime DataChannel event stream. Drives:
   *  - flowPhase ("intro" → "questions" → "closing" → "completed")
   *  - questionsAsked (# of agent responses AFTER greeting)
   *  - agentState ("thinking" → "speaking" → "listening")
   *  - transcriptsRef + latestCaptions (per-turn agent / candidate transcript)
   *
   * Stable identity (no deps) — installed on the rtc client via setOpenAiEventListener.
   */
  const handleOpenAiEvent = useCallback((event: OpenAiServerEvent) => {
    const { type, payload } = event;

    if (type === "response.created") {
      const respId = readString(payload.response, "id") ?? readString(payload, "response_id") ?? null;
      lastResponseIdRef.current = respId;
      setAgentState("thinking");
      setFlowPhase((prev) => (prev === "lobby" ? "intro" : prev));
      return;
    }

    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      setAgentState((prev) => (prev === "thinking" ? "speaking" : prev === "idle" ? "speaking" : prev));
      return;
    }

    if (
      type === "response.output_audio_transcript.delta" ||
      type === "response.audio_transcript.delta"
    ) {
      const itemId = readString(payload, "item_id") ?? readString(payload, "response_id") ?? "current";
      const delta = readString(payload, "delta") ?? "";
      if (delta) {
        const current = agentTranscriptBufferRef.current.get(itemId) ?? "";
        agentTranscriptBufferRef.current.set(itemId, current + delta);
        scheduleCaptionUpdate("agent", current + delta);
      }
      return;
    }

    if (
      type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done"
    ) {
      const itemId = readString(payload, "item_id") ?? readString(payload, "response_id") ?? "current";
      const transcript =
        readString(payload, "transcript") ?? agentTranscriptBufferRef.current.get(itemId) ?? "";
      if (transcript.trim().length > 0) {
        const turn: TranscriptTurn = {
          role: "agent",
          text: transcript,
          ts: Date.now(),
          itemId
        };
        transcriptsRef.current.push(turn);
        setTranscripts((prev) => [...prev, turn]);
        scheduleCaptionUpdate("agent", transcript);
      }
      agentTranscriptBufferRef.current.delete(itemId);
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = readString(payload, "transcript") ?? "";
      const itemId = readString(payload, "item_id") ?? undefined;
      if (transcript.trim().length > 0) {
        const turn: TranscriptTurn = {
          role: "candidate",
          text: transcript,
          ts: Date.now(),
          ...(itemId ? { itemId } : {})
        };
        transcriptsRef.current.push(turn);
        setTranscripts((prev) => [...prev, turn]);
        scheduleCaptionUpdate("candidate", transcript);
      }
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      setAgentState("listening");
      return;
    }

    if (type === "response.done") {
      setAgentState("listening");
      // First response.done = end of greeting → switch to questions phase.
      // Subsequent ones are answers to interview questions; count them.
      if (!greetingDoneRef.current) {
        greetingDoneRef.current = true;
        setFlowPhase("questions");
      } else {
        setQuestionsAsked((prev) => prev + 1);
      }
      lastResponseIdRef.current = null;
      return;
    }

    if (type === "response.cancelled") {
      setAgentState("listening");
      return;
    }

    if (type === "session.created" || type === "session.updated") {
      // Session is live but agent has not yet generated greeting.
      // We promote lobby → intro on the FIRST response.created (above).
      return;
    }
  }, []);

  /** Throttled caption updater — drops "blink" effect on rapid deltas. */
  const scheduleCaptionUpdate = (role: "agent" | "candidate", text: string) => {
    setLatestCaptions((prev) => ({ ...prev, [role]: text }));
    if (captionFadeTimerRef.current[role]) {
      clearTimeout(captionFadeTimerRef.current[role] as ReturnType<typeof setTimeout>);
    }
    captionFadeTimerRef.current[role] = setTimeout(() => {
      setLatestCaptions((prev) => {
        if (prev[role] !== text) return prev;
        return { ...prev, [role]: undefined };
      });
    }, 8000);
  };

  const ensureClient = useCallback(() => {
    if (!rtcRef.current) {
      rtcRef.current = new WebRtcInterviewClient({
        onStateChange: setRtcState,
        onRemoteStream: setRemoteAudioStream,
        onOpenAiEvent: handleOpenAiEvent
      });
    } else {
      // Re-bind in case React Fast Refresh / hot reload created a new closure.
      rtcRef.current.setOpenAiEventListener(handleOpenAiEvent);
    }
    return rtcRef.current;
  }, [handleOpenAiEvent]);

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
                  await postIntroResponseToRtc(rtc, effectiveContext, "reconnect");
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
              // See postIntroResponseToRtc above — minimal safe payload only.
              // Никаких turn_detection на runtime update: endpoint silently
              // отклонит whole update вместе с instructions, и при reconnect
              // агент опять уедет в дефолтное приветствие.
              await rtc.postEvent({
                type: "session.update",
                session: {
                  type: "realtime",
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

    // HARD ROLE GUARD: создать новую AI-сессию (meeting + OpenAI Realtime
    // peer) имеет право ТОЛЬКО кандидат, зашедший по своей уникальной
    // ссылке. Раньше HR из dashboard мог нажать «Запустить интервью» →
    // хук поднимал meeting без кандидата в комнате, AI говорил с HR как
    // с кандидатом, а реальный кандидат потом получал «сессия уже
    // завершена». Whitelist легальных инициаторов:
    //   - candidate_auto_start  (candidate-flow, переход по ссылке)
    //   - join_stream           (кандидат присоединился к stream-room,
    //                            в реальном стеке попадает в hydrate
    //                            path раньше чем сюда)
    //   - webrtc_restore        (внутренняя реконнект-логика хука)
    //   - candidate_*           (любой наш future candidate trigger)
    // Все прочие источники (manual_start_button из HR-dashboard, любой
    // внешний вызов) — блокируются с явной ошибкой.
    const CANDIDATE_INITIATED_TRIGGERS = new Set<string>([
      "candidate_auto_start",
      "join_stream",
      "webrtc_restore"
    ]);
    const isCandidateInitiated =
      CANDIDATE_INITIATED_TRIGGERS.has(triggerSource) || triggerSource.startsWith("candidate_");
    if (!isCandidateInitiated) {
      throw new Error(
        "Интервью может запустить только кандидат, перешедший по своей персональной ссылке. HR-сторона не инициирует AI-сессию."
      );
    }

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
    // Reset flow / agent / transcript state — fresh interview from scratch.
    setFlowPhase("intro");
    setAgentState("idle");
    setQuestionsAsked(0);
    setLatestCaptions({});
    transcriptsRef.current = [];
    setTranscripts([]);
    agentTranscriptBufferRef.current.clear();
    greetingDoneRef.current = false;
    lastResponseIdRef.current = null;

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

      const collectedTranscripts = transcriptsRef.current.slice();
      const summaryPayload = await resolveInterviewSummaryPayload(summaryInput, collectedTranscripts);
      setLastInterviewSummary(summaryPayload);
      setFlowPhase("closing");

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
        // Tell OpenAI to abort whatever the agent is currently saying. Without
        // this the agent keeps talking until the WebRTC peer connection is
        // closed below — user perceives "Завершить" as not stopping the agent.
        // response.cancel is a real OpenAI client event (see whitelist in
        // webrtc-client.ts). It's a no-op if no response is in flight.
        await rtc
          .postEvent({
            type: "response.cancel"
          })
          .catch(() => undefined);
        // Telemetry breadcrumb for gateway logs (gateway-only, OpenAI ignores).
        await rtc
          .postEvent({
            type: "session.update",
            source: "frontend",
            message: "session_stopping"
          })
          .catch(() => undefined);
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
      setFlowPhase("completed");
      setAgentState("idle");
      setLatestCaptions({});
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

  // Cleanup caption fade timers on unmount.
  useEffect(() => {
    return () => {
      const timers = captionFadeTimerRef.current;
      if (timers.agent) clearTimeout(timers.agent);
      if (timers.candidate) clearTimeout(timers.candidate);
    };
  }, []);

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
    /** UI flow indicator (independent from infra `phase`). */
    flowPhase,
    /** Visual indicator state for the agent avatar tile. */
    agentState,
    /** Number of agent responses that came AFTER the greeting reply. */
    questionsAsked,
    /** Latest single-turn caption per role; keys disappear after ~8s of silence. */
    latestCaptions,
    /** Accumulated per-turn transcript history (agent + candidate). Reactive. */
    transcripts,
    start,
    stop,
    markFailed,
    setObserverTalkIsolation,
    hydrateActiveSession
  };
}
