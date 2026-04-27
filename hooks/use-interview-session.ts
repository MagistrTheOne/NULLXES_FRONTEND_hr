"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ApiRequestError,
  closeRealtimeSession,
  failMeeting,
  getRealtimeSessionState,
  getRuntimePromptSettingsSoft,
  getInterviewById,
  issueRuntimeCommand,
  linkInterviewSession,
  sendRealtimeEvent,
  startMeeting,
  stopMeeting,
  updateInterviewStatus,
  type InterviewDetail,
  type JobAiInterviewStatus,
  type RuntimePromptSettings
} from "@/lib/api";
import { buildInterviewInstructions, buildOpeningUtterance } from "@/lib/interview-agent-prompt";
import { createAgentContextTrace, type AgentContextTrace } from "@/lib/interview-context-diagnostics";
import { mergeStartContextWithInterviewDetail } from "@/lib/interview-detail-fields";
import type { InterviewStartContext } from "@/lib/interview-start-context";
import {
  WebRtcInterviewClient,
  runAudioInputPreflight,
  type OpenAiServerEvent,
  type WebRtcConnectionState
} from "@/lib/webrtc-client";
import { getDefaultElevenLabsVoiceId, HR_ELEVENLABS_VOICE_STORAGE_KEY } from "@/lib/interview-voice-presets";
import { playAgentUtteranceWithElevenLabs, stopAgentElevenLabsPlayback } from "@/lib/agent-elevenlabs-playback";

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
export type InterviewDegradationState = {
  telemetryUnavailable: boolean;
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
const PROMPT_SETTINGS_POLL_MS = 60_000;
const DEFAULT_RUNTIME_PROMPT_SETTINGS: RuntimePromptSettings = {};

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

/** When true, agent speech uses ElevenLabs (text-only OpenAI responses + local playback). */
function elevenLabsAgentReplacesOpenAiAudio(): boolean {
  return process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT === "1";
}

function openAiAgentResponseModalities(): ("audio" | "text")[] {
  return elevenLabsAgentReplacesOpenAiAudio() ? ["text"] : ["audio", "text"];
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

function inferMeetingFailureReasonCode(
  message: string
):
  | "openai_call_failed"
  | "openai_client_secret_failed"
  | "sfu_join_failed"
  | "network_timeout"
  | "device_permission_denied"
  | "audio_input_unavailable"
  | "gateway_upstream_unreachable"
  | "unknown" {
  const lower = message.toLowerCase();
  if (lower.includes("openai client secret")) return "openai_client_secret_failed";
  if (lower.includes("realtime session failed") || lower.includes("openai")) return "openai_call_failed";
  if (lower.includes("stream") || lower.includes("sfu")) return "sfu_join_failed";
  if (lower.includes("timeout") || lower.includes("timed out")) return "network_timeout";
  if (lower.includes("permission") || lower.includes("notallowederror")) return "device_permission_denied";
  if (lower.includes("getusermedia") || lower.includes("audio input")) return "audio_input_unavailable";
  if (lower.includes("upstream") || lower.includes("gateway")) return "gateway_upstream_unreachable";
  return "unknown";
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
  mode: IntroMode = "first",
  runtimePromptSettings?: RuntimePromptSettings,
  gateOptions?: {
    getSessionUpdatedVersion: () => number;
    waitForSessionUpdatedAck: (previousVersion: number, timeoutMs: number) => Promise<boolean>;
  }
): Promise<void> {
  const runtimeInstructions = buildInterviewInstructions(effectiveContext, runtimePromptSettings);
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
  const sessionUpdatePayload = {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: runtimeInstructions
    }
  } as const;

  if (!gateOptions) {
    await rtc.postEvent(sessionUpdatePayload);
  } else {
    const MAX_ATTEMPTS = 3;
    const ACK_TIMEOUT_MS = 1800;
    let acked = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const previousVersion = gateOptions.getSessionUpdatedVersion();
      await rtc.postEvent(sessionUpdatePayload);
      acked = await gateOptions.waitForSessionUpdatedAck(previousVersion, ACK_TIMEOUT_MS);
      if (acked) {
        break;
      }
      // eslint-disable-next-line no-console
      console.warn(`[interview] session.update ACK timeout (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }
    if (!acked) {
      // eslint-disable-next-line no-console
      console.warn("[interview] proceeding with response.create without confirmed session.updated ACK");
    }
  }

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
      modalities: openAiAgentResponseModalities(),
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

export type InterviewSessionStopOptions = {
  interviewId?: number;
  /** Timer-driven / operational shutdown: bypass «кандидат в Stream» guard. */
  skipInterviewCandidateStopGuard?: boolean;
};

export function useInterviewSession(options?: { isCandidateFlow?: boolean }) {
  const isCandidateFlow = options?.isCandidateFlow ?? false;
  const [phase, setPhase] = useState<InterviewPhase>("idle");
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const [lastAgentContextTrace, setLastAgentContextTrace] = useState<AgentContextTrace | null>(null);
  const [rtcState, setRtcState] = useState<WebRtcConnectionState>("idle");
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
  const [agentInputEnabled, setAgentInputEnabled] = useState(true);
  const [agentPaused, setAgentPaused] = useState(false);
  const [runtimeRecoveryState, setRuntimeRecoveryState] = useState<RuntimeRecoveryState>("idle");
  const [activeInterviewId, setActiveInterviewId] = useState<number | null>(null);
  const [telemetryUnavailable, setTelemetryUnavailable] = useState(false);
  const [activePromptSettings, setActivePromptSettings] = useState<RuntimePromptSettings | null>(null);
  const [promptSettingsSource, setPromptSettingsSource] = useState<"remote" | "fallback_default">("fallback_default");
  const [promptSettingsLastStatus, setPromptSettingsLastStatus] = useState<number | null>(null);
  const [promptSettingsLastError, setPromptSettingsLastError] = useState<string | null>(null);

  // Phase indicator (B), agent state (C), live captions (F.3)
  const [flowPhase, setFlowPhase] = useState<InterviewFlowPhase>("lobby");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [latestCaptions, setLatestCaptions] = useState<LiveCaptions>({});
  /**
   * Reactive mirror of `transcriptsRef.current` — identical data, but state so
   * the HR insight panel can re-render when new turns arrive. We push to BOTH
   * the ref (used for lifecycle cleanup) and this state (consumed by UI).
   * Kept as a ref-shaped array, not a Map, because transcript order is meaningful.
   */
  const [transcripts, setTranscripts] = useState<TranscriptTurn[]>([]);
  const interviewCandidatePresentRef = useRef(false);
  const [interviewCandidatePresent, setInterviewCandidatePresent] = useState(false);
  const reportInterviewCandidatePresent = useCallback((present: boolean) => {
    interviewCandidatePresentRef.current = present;
    setInterviewCandidatePresent(present);
  }, []);
  const [sessionElevenLabsVoiceId, setSessionElevenLabsVoiceId] = useState(() => getDefaultElevenLabsVoiceId());
  const sessionElevenLabsVoiceIdRef = useRef(sessionElevenLabsVoiceId);
  const elevenLabsUtteranceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    sessionElevenLabsVoiceIdRef.current = sessionElevenLabsVoiceId;
  }, [sessionElevenLabsVoiceId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = window.localStorage.getItem(HR_ELEVENLABS_VOICE_STORAGE_KEY)?.trim();
        if (stored) {
          sessionElevenLabsVoiceIdRef.current = stored;
          setSessionElevenLabsVoiceId(stored);
        }
      } catch {
        /* noop */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const v = sessionElevenLabsVoiceId.trim();
      if (v) {
        window.localStorage.setItem(HR_ELEVENLABS_VOICE_STORAGE_KEY, v);
      }
    } catch {
      /* noop */
    }
  }, [sessionElevenLabsVoiceId]);

  const rtcRef = useRef<WebRtcInterviewClient | null>(null);
  const reconnectAttemptForSessionRef = useRef<string | null>(null);
  const avatarPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastInterviewContextRef = useRef<InterviewStartContext | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const agentStateRef = useRef<AgentState>("idle");
  const lastGoodPromptSettingsRef = useRef<RuntimePromptSettings | null>(null);
  const promptSettingsInitializedRef = useRef(false);
  const sessionUpdatedVersionRef = useRef(0);
  const pendingSessionUpdatedWaitersRef = useRef<
    Array<{ previousVersion: number; resolve: (acked: boolean) => void }>
  >([]);

  // Transcript collection (F.2). We use refs so accumulation does not trigger
  // re-renders on every audio-transcript delta — only the captions state does.
  const transcriptsRef = useRef<TranscriptTurn[]>([]);
  const agentTranscriptBufferRef = useRef<Map<string, string>>(new Map());
  const greetingDoneRef = useRef(false);
  const lastResponseIdRef = useRef<string | null>(null);
  const pendingCancelRef = useRef<{
    requestId: string;
    requestedAtMs: number;
    reason: "manual_stop" | "barge_in";
    responseId: string | null;
  } | null>(null);
  const cancelAckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionFadeTimerRef = useRef<{ agent: ReturnType<typeof setTimeout> | null; candidate: ReturnType<typeof setTimeout> | null }>({
    agent: null,
    candidate: null
  });
  const getSessionUpdatedVersion = useCallback(() => sessionUpdatedVersionRef.current, []);
  const flushSessionUpdatedWaiters = useCallback((acked: boolean) => {
    if (pendingSessionUpdatedWaitersRef.current.length === 0) {
      return;
    }
    const waiters = pendingSessionUpdatedWaitersRef.current.splice(0, pendingSessionUpdatedWaitersRef.current.length);
    for (const waiter of waiters) {
      waiter.resolve(acked);
    }
  }, []);
  const waitForSessionUpdatedAck = useCallback(
    (previousVersion: number, timeoutMs: number): Promise<boolean> => {
      if (sessionUpdatedVersionRef.current > previousVersion) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiter = {
          previousVersion,
          resolve: (acked: boolean) => resolve(acked)
        };
        pendingSessionUpdatedWaitersRef.current.push(waiter);
        const timer = setTimeout(() => {
          const idx = pendingSessionUpdatedWaitersRef.current.indexOf(waiter);
          if (idx >= 0) {
            pendingSessionUpdatedWaitersRef.current.splice(idx, 1);
          }
          resolve(false);
        }, timeoutMs);
        const originalResolve = waiter.resolve;
        waiter.resolve = (acked: boolean) => {
          clearTimeout(timer);
          originalResolve(acked);
        };
      });
    },
    []
  );
  const emitFrontendTelemetry = useCallback((type: string, payload: Record<string, unknown>) => {
    const sid = activeSessionIdRef.current;
    if (!sid) {
      return;
    }
    void sendRealtimeEvent(sid, {
      type,
      source: "frontend",
      ...payload
    }).catch(() => undefined);
  }, []);
  const effectivePromptSettings = activePromptSettings ?? DEFAULT_RUNTIME_PROMPT_SETTINGS;

  useEffect(() => {
    let cancelled = false;
    const pullPromptSettings = async () => {
      const result = await getRuntimePromptSettingsSoft();
      if (cancelled) {
        return;
      }
      setPromptSettingsLastStatus(result.status || null);
      if (result.ok && result.settings) {
        lastGoodPromptSettingsRef.current = result.settings;
        promptSettingsInitializedRef.current = true;
        setActivePromptSettings(result.settings);
        setPromptSettingsSource("remote");
        setPromptSettingsLastError(null);
        return;
      }

      setPromptSettingsLastError(result.error ?? "settings_fetch_failed");
      if (!promptSettingsInitializedRef.current) {
        promptSettingsInitializedRef.current = true;
        setActivePromptSettings(DEFAULT_RUNTIME_PROMPT_SETTINGS);
        setPromptSettingsSource("fallback_default");
      }
    };

    void pullPromptSettings();
    const timer = setInterval(() => {
      void pullPromptSettings();
    }, PROMPT_SETTINGS_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /** Throttled caption updater — drops "blink" effect on rapid deltas. */
  const scheduleCaptionUpdate = useCallback((role: "agent" | "candidate", text: string) => {
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
  }, []);

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
      if (elevenLabsAgentReplacesOpenAiAudio()) {
        elevenLabsUtteranceAbortRef.current?.abort();
        elevenLabsUtteranceAbortRef.current = new AbortController();
      }
      return;
    }

    if (elevenLabsAgentReplacesOpenAiAudio()) {
      if (type === "response.output_text.delta" || type === "response.text.delta") {
        const itemId = readString(payload, "item_id") ?? readString(payload, "response_id") ?? "current";
        const delta = readString(payload, "delta") ?? "";
        if (delta) {
          const current = agentTranscriptBufferRef.current.get(itemId) ?? "";
          agentTranscriptBufferRef.current.set(itemId, current + delta);
          scheduleCaptionUpdate("agent", current + delta);
        }
        setAgentState((prev) => (prev === "thinking" ? "speaking" : prev === "idle" ? "speaking" : prev));
        return;
      }

      if (type === "response.output_text.done" || type === "response.text.done") {
        const itemId = readString(payload, "item_id") ?? readString(payload, "response_id") ?? "current";
        const transcript =
          readString(payload, "text") ??
          readString(payload, "transcript") ??
          agentTranscriptBufferRef.current.get(itemId) ??
          "";
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

        const trimmed = transcript.trim();
        if (trimmed.length > 0) {
          const signal = elevenLabsUtteranceAbortRef.current?.signal;
          void playAgentUtteranceWithElevenLabs(trimmed, sessionElevenLabsVoiceIdRef.current, { signal }).catch((err) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              return;
            }
            if (err instanceof Error && err.name === "AbortError") {
              return;
            }
            console.warn("[elevenlabs-agent-tts] playback error", err);
          });
        }
        return;
      }
    }

    if (!elevenLabsAgentReplacesOpenAiAudio()) {
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
      if (agentStateRef.current === "speaking") {
        const requestId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `barge-${Date.now()}`;
        const now = Date.now();
        pendingCancelRef.current = {
          requestId,
          requestedAtMs: now,
          reason: "barge_in",
          responseId: lastResponseIdRef.current
        };
        emitFrontendTelemetry("agent.cancel.requested", {
          requestId,
          reason: "barge_in",
          responseId: lastResponseIdRef.current,
          requestedAtMs: now
        });
      }
      setAgentState("listening");
      return;
    }

    if (type === "response.done") {
      if (pendingCancelRef.current) {
        const pending = pendingCancelRef.current;
        const ackAtMs = Date.now();
        if (cancelAckTimeoutRef.current) {
          clearTimeout(cancelAckTimeoutRef.current);
          cancelAckTimeoutRef.current = null;
        }
        emitFrontendTelemetry("agent.cancel.acknowledged", {
          requestId: pending.requestId,
          reason: pending.reason,
          ackType: "response.done",
          responseId: pending.responseId,
          requestedAtMs: pending.requestedAtMs,
          ackAtMs,
          latencyMs: ackAtMs - pending.requestedAtMs
        });
        pendingCancelRef.current = null;
      }
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
      if (pendingCancelRef.current) {
        const pending = pendingCancelRef.current;
        const ackAtMs = Date.now();
        if (cancelAckTimeoutRef.current) {
          clearTimeout(cancelAckTimeoutRef.current);
          cancelAckTimeoutRef.current = null;
        }
        emitFrontendTelemetry("agent.cancel.acknowledged", {
          requestId: pending.requestId,
          reason: pending.reason,
          ackType: "response.cancelled",
          responseId: pending.responseId,
          requestedAtMs: pending.requestedAtMs,
          ackAtMs,
          latencyMs: ackAtMs - pending.requestedAtMs
        });
        pendingCancelRef.current = null;
      }
      setAgentState("listening");
      elevenLabsUtteranceAbortRef.current?.abort();
      stopAgentElevenLabsPlayback();
      return;
    }

    if (type === "session.updated") {
      sessionUpdatedVersionRef.current += 1;
      if (pendingSessionUpdatedWaitersRef.current.length > 0) {
        const waiters = pendingSessionUpdatedWaitersRef.current.splice(
          0,
          pendingSessionUpdatedWaitersRef.current.length
        );
        for (const waiter of waiters) {
          waiter.resolve(sessionUpdatedVersionRef.current > waiter.previousVersion);
        }
      }
      return;
    }

    if (type === "session.created") {
      // Session is live but agent has not yet generated greeting.
      // We promote lobby → intro on the FIRST response.created (above).
      return;
    }
  }, [emitFrontendTelemetry, scheduleCaptionUpdate]);

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

  const pauseAgent = useCallback(async () => {
    if (phase !== "connected") {
      return;
    }
    const rtc = ensureClient();
    const activeSessionId = rtc.getSessionId();
    if (!activeSessionId) {
      return;
    }

    setAgentPaused(true);
    rtc.setAudioInputEnabled(false);
    setAgentInputEnabled(false);
    setAgentState("idle");

    try {
      await rtc.postEvent({
        type: "response.cancel"
      });
    } catch {
      // Ignore no-op cancel failures: pause state remains local.
    }
    elevenLabsUtteranceAbortRef.current?.abort();
    stopAgentElevenLabsPlayback();
    try {
      await rtc.postEvent({
        type: "session.update",
        source: "frontend",
        message: "agent_paused"
      });
    } catch {
      // Breadcrumb only.
    }
    await sendRealtimeEvent(activeSessionId, {
      type: "hr.agent.pause",
      source: "jobaidemo",
      meetingId: meetingId ?? undefined,
      paused: true
    }).catch(() => undefined);
    if (meetingId) {
      await issueRuntimeCommand(meetingId, {
        type: "agent.pause",
        issuedBy: "hr_ui",
        payload: { sessionId: activeSessionId }
      }).catch(() => undefined);
    }
  }, [ensureClient, meetingId, phase]);

  const resumeAgent = useCallback(async () => {
    if (phase !== "connected") {
      return;
    }
    const rtc = ensureClient();
    const activeSessionId = rtc.getSessionId();
    if (!activeSessionId) {
      return;
    }

    setAgentPaused(false);
    rtc.setAudioInputEnabled(true);
    setAgentInputEnabled(true);
    setAgentState("listening");

    try {
      await rtc.postEvent({
        type: "session.update",
        source: "frontend",
        message: "agent_resumed"
      });
    } catch {
      // Breadcrumb only.
    }
    try {
      await rtc.postEvent({
        type: "response.create",
        response: {
          modalities: openAiAgentResponseModalities(),
          instructions: "Продолжи интервью с текущего места и задай следующий уместный вопрос."
        }
      });
    } catch {
      // Agent will continue naturally on next candidate speech.
    }
    await sendRealtimeEvent(activeSessionId, {
      type: "hr.agent.resume",
      source: "jobaidemo",
      meetingId: meetingId ?? undefined,
      paused: false
    }).catch(() => undefined);
    if (meetingId) {
      await issueRuntimeCommand(meetingId, {
        type: "agent.resume",
        issuedBy: "hr_ui",
        payload: { sessionId: activeSessionId }
      }).catch(() => undefined);
    }
  }, [ensureClient, meetingId, phase]);

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    if (!sessionId || phase !== "connected") {
      queueMicrotask(() => {
        setAvatarReady(false);
        setTelemetryUnavailable(false);
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
          setTelemetryUnavailable(false);
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
          setTelemetryUnavailable(true);
          setAvatarReady(false);
          if (avatarPollTimerRef.current) {
            clearInterval(avatarPollTimerRef.current);
            avatarPollTimerRef.current = null;
          }
          return;
        }
        setTelemetryUnavailable(false);
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
      queueMicrotask(() => {
        setRuntimeRecoveryState((prev) => (prev === "idle" ? prev : "idle"));
      });
      return;
    }

    const rtc = ensureClient();
    if (rtc.getState() === "connected" && rtc.getSessionId()) {
      queueMicrotask(() => {
        setRuntimeRecoveryState((prev) => (prev === "idle" ? prev : "idle"));
      });
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
                  await postIntroResponseToRtc(rtc, effectiveContext, "reconnect", effectivePromptSettings, {
                    getSessionUpdatedVersion,
                    waitForSessionUpdatedAck
                  });
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

    // Не добавлять `runtimeRecoveryState` в deps ниже: при setState("recovering") эффект
    // перезапускался бы, cleanup ставил cancelled=true и обрывал in-flight connect(),
    // а повторный вход блокировался reconnectAttemptForSessionRef — вечное «Восстановление…».
    void restoreRuntime();
    return () => {
      cancelled = true;
    };
  }, [
    activeInterviewId,
    effectivePromptSettings,
    ensureClient,
    getSessionUpdatedVersion,
    meetingId,
    phase,
    sessionId,
    waitForSessionUpdatedAck
  ]);

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
              const runtimeInstructions = buildInterviewInstructions(effectiveContext, effectivePromptSettings);
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

    const preflight = await runAudioInputPreflight();
    if (!preflight.ok) {
      throw new Error(preflight.message);
    }

    setPhase("starting");
    setError(null);
    setAgentPaused(false);
    setRuntimeRecoveryState("idle");
    setTelemetryUnavailable(false);
    sessionUpdatedVersionRef.current = 0;
    flushSessionUpdatedWaiters(false);
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

    let meetingStarted = false;
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
      meetingStarted = true;
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
      await postIntroResponseToRtc(rtc, effectiveContext, "first", effectivePromptSettings, {
        getSessionUpdatedVersion,
        waitForSessionUpdatedAck
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
      if (internalMeetingId && meetingStarted) {
        try {
          await failMeeting(internalMeetingId, {
            status: "failed_connect_ws_audio",
            reason: "frontend_start_failed",
            reasonCode: inferMeetingFailureReasonCode(startError.message),
            metadata: {
              failureSource: "useInterviewSession.start"
            }
          });
        } catch {
          // Ignore secondary fail-notification errors in prototype.
        }
      }
      throw startError;
    }
  }, [effectivePromptSettings, ensureClient, flushSessionUpdatedWaiters, getSessionUpdatedVersion, meetingId, phase, sessionId, waitForSessionUpdatedAck]);

  const stop = useCallback(async (options?: InterviewSessionStopOptions): Promise<boolean> => {
    if (!meetingId) {
      return false;
    }
    if (
      !options?.skipInterviewCandidateStopGuard &&
      !isCandidateFlow &&
      !interviewCandidatePresentRef.current
    ) {
      toast.error("Невозможно завершить сессию без кандидата");
      return false;
    }

    setPhase("stopping");
    setRuntimeRecoveryState("idle");
    try {
      const activeMeetingId = meetingId;
      const activeSessionId = sessionId;
      const rtc = rtcRef.current;
      await issueRuntimeCommand(activeMeetingId, {
        type: "session.stop",
        issuedBy: "hr_ui",
        payload: {
          sessionId: activeSessionId ?? undefined,
          interviewId: options?.interviewId ?? activeInterviewId ?? undefined
        }
      }).catch(() => undefined);

      setFlowPhase("closing");

      if (rtc?.getSessionId()) {
        // Tell OpenAI to abort whatever the agent is currently saying. Without
        // this the agent keeps talking until the WebRTC peer connection is
        // closed below — user perceives "Завершить" as not stopping the agent.
        // response.cancel is a real OpenAI client event (see whitelist in
        // webrtc-client.ts). It's a no-op if no response is in flight.
        const cancelRequestId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `stop-${Date.now()}`;
        const cancelRequestedAtMs = Date.now();
        pendingCancelRef.current = {
          requestId: cancelRequestId,
          requestedAtMs: cancelRequestedAtMs,
          reason: "manual_stop",
          responseId: lastResponseIdRef.current
        };
        emitFrontendTelemetry("agent.cancel.requested", {
          requestId: cancelRequestId,
          reason: "manual_stop",
          responseId: lastResponseIdRef.current,
          requestedAtMs: cancelRequestedAtMs
        });
        if (cancelAckTimeoutRef.current) {
          clearTimeout(cancelAckTimeoutRef.current);
          cancelAckTimeoutRef.current = null;
        }
        cancelAckTimeoutRef.current = setTimeout(() => {
          if (pendingCancelRef.current?.requestId !== cancelRequestId) {
            return;
          }
          emitFrontendTelemetry("agent.cancel.ack_timeout", {
            requestId: cancelRequestId,
            reason: "manual_stop",
            responseId: lastResponseIdRef.current,
            requestedAtMs: cancelRequestedAtMs,
            timeoutMs: 2500
          });
        }, 2500);
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
      elevenLabsUtteranceAbortRef.current?.abort();
      elevenLabsUtteranceAbortRef.current = null;
      stopAgentElevenLabsPlayback();
      rtc?.close();
      if (activeSessionId) {
        await closeRealtimeSession(activeSessionId).catch(() => undefined);
      }
      setMeetingId(null);
      setSessionId(null);
      setActiveInterviewId(null);
      lastInterviewContextRef.current = null;
      setAvatarReady(false);
      setTelemetryUnavailable(false);
      setAgentInputEnabled(true);
      setAgentPaused(false);
      sessionUpdatedVersionRef.current = 0;
      flushSessionUpdatedWaiters(false);
      pendingCancelRef.current = null;
      if (cancelAckTimeoutRef.current) {
        clearTimeout(cancelAckTimeoutRef.current);
        cancelAckTimeoutRef.current = null;
      }
      setFlowPhase("completed");
      setAgentState("idle");
      setLatestCaptions({});
      setPhase("idle");
      return true;
    } catch (err) {
      if (cancelAckTimeoutRef.current) {
        clearTimeout(cancelAckTimeoutRef.current);
        cancelAckTimeoutRef.current = null;
      }
      setPhase("failed");
      setError(err instanceof Error ? err.message : "Failed to stop session");
      return false;
    }
  }, [activeInterviewId, emitFrontendTelemetry, flushSessionUpdatedWaiters, isCandidateFlow, meetingId, sessionId]);

  const markFailed = useCallback(async () => {
    if (!meetingId) {
      return;
    }
    await failMeeting(meetingId, {
      status: "failed_connect_ws_audio",
      reason: "manual_mark_failed",
      reasonCode: "unknown",
      metadata: {
        failureSource: "useInterviewSession.markFailed"
      }
    });
    setRuntimeRecoveryState("idle");
    setPhase("failed");
  }, [meetingId]);

  const degradationState = useMemo<InterviewDegradationState>(
    () => ({
      telemetryUnavailable
    }),
    [telemetryUnavailable]
  );

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
      if (cancelAckTimeoutRef.current) {
        clearTimeout(cancelAckTimeoutRef.current);
        cancelAckTimeoutRef.current = null;
      }
      flushSessionUpdatedWaiters(false);
    };
  }, [flushSessionUpdatedWaiters]);

  return {
    phase,
    statusLabel,
    meetingId,
    sessionId,
    avatarReady,
    degradationState,
    lastAgentContextTrace,
    rtcState,
    error,
    remoteAudioStream,
    agentInputEnabled,
    agentPaused,
    runtimeRecoveryState,
    promptSettingsSource,
    promptSettingsLastStatus,
    promptSettingsLastError,
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
    interviewCandidatePresent,
    reportInterviewCandidatePresent,
    sessionElevenLabsVoiceId,
    setSessionElevenLabsVoiceId,
    markFailed,
    pauseAgent,
    resumeAgent,
    setObserverTalkIsolation,
    hydrateActiveSession
  };
}
