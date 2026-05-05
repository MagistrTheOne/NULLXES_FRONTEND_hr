"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ApiRequestError,
  closeRealtimeSession,
  failMeeting,
  getRuntimePromptSettingsSoft,
  getRuntimeSnapshot,
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

const OPENAI_RESPONSE_MODALITIES: ("audio" | "text")[] = ["audio", "text"];

type RuntimeEvent = {
  type: string;
  revision: number;
  payload: Record<string, unknown>;
};

export type InterviewPhase = "idle" | "starting" | "connected" | "stopping" | "failed";
export type InterviewStartResult = {
  meetingId: string;
  sessionId: string;
};
export type RuntimeRecoveryState = "idle" | "recovering" | "failed";

/** UX phases derived from Realtime events (indicator + thank-you). */
export type InterviewFlowPhase = "lobby" | "intro" | "questions" | "closing" | "completed";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";
export type VoiceProvider = "openai";

export type TranscriptTurn = {
  role: "agent" | "candidate";
  text: string;
  ts: number;
  itemId?: string;
};

type ResumeCheckpoint = {
  phase: InterviewFlowPhase | null;
  questionIndex: number | null;
  questionText: string | null;
  totalQuestions: number | null;
  lastAssistantText: string | null;
  lastCandidateText: string | null;
  transcriptTail: string[];
  pausedAt: number;
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
const HARD_CONTEXT_GUARD_ENABLED = process.env.NEXT_PUBLIC_INTERVIEW_HARD_GUARD === "1";
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [0, 450, 1400] as const;
const AVATAR_POLL_MS_ACTIVE = 2000;
const PROMPT_SETTINGS_POLL_MS = 60_000;
const DEFAULT_RUNTIME_PROMPT_SETTINGS: RuntimePromptSettings = {};

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
  /**
   * Realtime GA: each `session.update` must include `session.type: "realtime"`.
   * Keep payload minimal (`instructions` only) — adding `turn_detection` here can make the API reject the whole update (instructions lost). Tune VAD in gateway session create, not in this client update.
   */
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
      modalities: OPENAI_RESPONSE_MODALITIES,
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

async function transitionJobAiToStoppedDuringMeeting(interviewId: number): Promise<void> {
  const detail = await getInterviewById(interviewId).catch(() => null);
  const currentStatus = (detail?.projection.jobAiStatus ?? detail?.interview.status) as JobAiInterviewStatus | undefined;

  if (!currentStatus || currentStatus === "stopped_during_meeting") {
    return;
  }

  if (currentStatus === "pending") {
    await updateInterviewStatus(interviewId, "received");
    await updateInterviewStatus(interviewId, "in_meeting");
    await updateInterviewStatus(interviewId, "stopped_during_meeting");
    return;
  }
  if (currentStatus === "received") {
    await updateInterviewStatus(interviewId, "in_meeting");
    await updateInterviewStatus(interviewId, "stopped_during_meeting");
    return;
  }
  if (currentStatus === "in_meeting") {
    await updateInterviewStatus(interviewId, "stopped_during_meeting");
  }
}

export type InterviewSessionStopOptions = {
  interviewId?: number;
  /** Timer-driven / operational shutdown: bypass «кандидат в Stream» guard. */
  skipInterviewCandidateStopGuard?: boolean;
  /**
   * Terminal meeting status to persist in gateway + propagate downstream.
   * Default remains "completed" for backward compatibility.
   */
  finalStatus?: "completed" | "stopped_during_meeting";
};

const STREAM_OPENAI_AGENT_MODE_ENABLED = process.env.NEXT_PUBLIC_STREAM_OPENAI_AGENT_MODE === "1";

export function useInterviewSession(options?: { isCandidateFlow?: boolean }) {
  const isCandidateFlow = options?.isCandidateFlow ?? false;
  const [phase, setPhase] = useState<InterviewPhase>("idle");
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);
  const [avatarActiveSpeaker, setAvatarActiveSpeaker] = useState<"assistant" | "candidate" | null>(null);
  const [avatarDegradationLevel, setAvatarDegradationLevel] = useState<
    "none" | "soft" | "hard" | "fallback" | null
  >(null);
  const [lastAgentContextTrace, setLastAgentContextTrace] = useState<AgentContextTrace | null>(null);
  const [rtcState, setRtcState] = useState<WebRtcConnectionState>("idle");
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
  const lastRemoteAudioStreamRef = useRef<MediaStream | null>(null);
  const [agentInputEnabled, setAgentInputEnabled] = useState(true);
  const [agentPaused, setAgentPaused] = useState(false);
  const agentPausedRef = useRef(false);
  const pendingPauseCancelRef = useRef<{ resolve: () => void; timeoutId: ReturnType<typeof setTimeout> | null } | null>(
    null
  );
  const pauseResumeBusyRef = useRef(false);
  const [pauseResumeBusy, setPauseResumeBusy] = useState(false);
  const [runtimeRecoveryState, setRuntimeRecoveryState] = useState<RuntimeRecoveryState>("idle");
  const [activeInterviewId, setActiveInterviewId] = useState<number | null>(null);
  const [telemetryUnavailable, setTelemetryUnavailable] = useState(false);
  const [activePromptSettings, setActivePromptSettings] = useState<RuntimePromptSettings | null>(null);
  const [promptSettingsSource, setPromptSettingsSource] = useState<"remote" | "fallback_default">("fallback_default");
  const [promptSettingsLastStatus, setPromptSettingsLastStatus] = useState<number | null>(null);
  const [promptSettingsLastError, setPromptSettingsLastError] = useState<string | null>(null);

  const [flowPhase, setFlowPhase] = useState<InterviewFlowPhase>("lobby");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const runtimeQuestionsRevisionRef = useRef(0);
  const [latestCaptions, setLatestCaptions] = useState<LiveCaptions>({});
  /**
   * Reactive mirror of `transcriptsRef.current` — identical data, but state so
   * the HR insight panel can re-render when new turns arrive. We push to BOTH
   * the ref (used for lifecycle cleanup) and this state (consumed by UI).
   * Kept as a ref-shaped array, not a Map, because transcript order is meaningful.
   */
  const [transcripts, setTranscripts] = useState<TranscriptTurn[]>([]);
  const resumeCheckpointRef = useRef<ResumeCheckpoint | null>(null);
  const [resumeCheckpoint, setResumeCheckpoint] = useState<ResumeCheckpoint | null>(null);
  const interviewCandidatePresentRef = useRef(false);
  const [interviewCandidatePresent, setInterviewCandidatePresent] = useState(false);
  const reportInterviewCandidatePresent = useCallback((present: boolean) => {
    interviewCandidatePresentRef.current = present;
    setInterviewCandidatePresent(present);
  }, []);

  useEffect(() => {
    if (!meetingId) {
      runtimeQuestionsRevisionRef.current = 0;
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (cancelled) return;
      const afterRevision = runtimeQuestionsRevisionRef.current;
      const res = await fetch(
        `/api/gateway/runtime/${encodeURIComponent(meetingId)}/events?afterRevision=${afterRevision}`,
        {
          method: "GET",
          credentials: "include"
        }
      ).catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json().catch(() => null)) as { events?: RuntimeEvent[] } | null;
      const events = Array.isArray(data?.events) ? (data!.events as RuntimeEvent[]) : [];
      for (const event of events) {
        if (typeof event?.revision === "number") {
          runtimeQuestionsRevisionRef.current = Math.max(runtimeQuestionsRevisionRef.current, event.revision);
        }
        if (event?.type === "runtime.question_advanced") {
          const idx = (event.payload as Record<string, unknown> | undefined)?.questionIndex;
          if (typeof idx === "number" && Number.isFinite(idx) && idx >= 0) {
            setQuestionsAsked(idx);
            setFlowPhase((prev) => (prev === "lobby" ? "questions" : prev));
          }
        }
      }
    };

    void poll().catch(() => undefined);
    const timer = window.setInterval(() => {
      void poll().catch(() => undefined);
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [meetingId]);
  const voiceProvider: VoiceProvider = "openai";

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

  useEffect(() => {
    agentPausedRef.current = agentPaused;
  }, [agentPaused]);
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

  const buildResumeCheckpoint = useCallback(
    (reason: "pause" | "before_resume" | "event_update"): ResumeCheckpoint => {
      const turns = transcriptsRef.current;
      const tail = turns
        .slice(Math.max(0, turns.length - 10))
        .map((t) => `${t.role === "agent" ? "HR" : "Кандидат"}: ${t.text.trim()}`.slice(0, 240));

      const lastAgent = [...turns].reverse().find((t) => t.role === "agent") ?? null;
      const lastCandidate = [...turns].reverse().find((t) => t.role === "candidate") ?? null;

      const questionIndex = flowPhase === "questions" ? questionsAsked : null;
      const questionText =
        flowPhase === "questions" ? (lastAgent?.text?.trim() ? lastAgent.text.trim() : null) : null;

      const checkpoint: ResumeCheckpoint = {
        phase: flowPhase ?? null,
        questionIndex,
        questionText,
        totalQuestions: null,
        lastAssistantText: lastAgent?.text?.trim() ? lastAgent.text.trim() : null,
        lastCandidateText: lastCandidate?.text?.trim() ? lastCandidate.text.trim() : null,
        transcriptTail: tail,
        pausedAt: Date.now()
      };

      if (process.env.NODE_ENV !== "production" && reason === "event_update") {
        void checkpoint;
      }
      return checkpoint;
    },
    [flowPhase, questionsAsked]
  );

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
      if (agentPausedRef.current) {
        return;
      }
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
      if (agentPausedRef.current) {
        return;
      }
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
        const checkpoint = buildResumeCheckpoint("event_update");
        resumeCheckpointRef.current = checkpoint;
        setResumeCheckpoint(checkpoint);
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
        const checkpoint = buildResumeCheckpoint("event_update");
        resumeCheckpointRef.current = checkpoint;
        setResumeCheckpoint(checkpoint);
      }
      return;
    }

    if (type === "error") {
      const err = (payload && typeof payload === "object" ? (payload as Record<string, unknown>).error : null) ?? payload;
      const errType = readString(err, "type") ?? readString(payload, "type") ?? null;
      const errCode = readString(err, "code") ?? null;
      const errMessage = readString(err, "message") ?? (err instanceof Error ? err.message : null);
      const eventId = readString(err, "event_id") ?? readString(payload, "event_id") ?? null;
      void errType;
      void errCode;
      void errMessage;
      void eventId;
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
      if (!greetingDoneRef.current) {
        greetingDoneRef.current = true;
        setFlowPhase("questions");
        setQuestionsAsked(0);
      }
      lastResponseIdRef.current = null;
      return;
    }

    if (type === "response.cancelled") {
      if (pendingPauseCancelRef.current) {
        const pending = pendingPauseCancelRef.current;
        pendingPauseCancelRef.current = null;
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        pending.resolve();
      }
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
      return;
    }
  }, [buildResumeCheckpoint, emitFrontendTelemetry, scheduleCaptionUpdate]);

  const ensureClient = useCallback(() => {
    if (!rtcRef.current) {
      rtcRef.current = new WebRtcInterviewClient({
        onStateChange: setRtcState,
        onRemoteStream: (stream) => {
          lastRemoteAudioStreamRef.current = stream;
          setRemoteAudioStream(stream);
        },
        onOpenAiEvent: handleOpenAiEvent
      });
    } else {
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
      }
    },
    [ensureClient]
  );

  const pauseAgent = useCallback(async () => {
    if (pauseResumeBusyRef.current) {
      return false;
    }
    if (phase !== "connected") {
      return false;
    }
    const rtc = ensureClient();
    const activeSessionId = rtc.getSessionId();
    if (!activeSessionId) {
      return false;
    }

    pauseResumeBusyRef.current = true;
    setPauseResumeBusy(true);

    const checkpoint = buildResumeCheckpoint("pause");
    resumeCheckpointRef.current = checkpoint;
    setResumeCheckpoint(checkpoint);
    void checkpoint;

    setAgentPaused(true);
    agentPausedRef.current = true;
    rtc.setAudioInputEnabled(false);
    setAgentInputEnabled(false);
    setAgentState("idle");
    setLatestCaptions((prev) => ({ ...prev, agent: undefined }));
    if (captionFadeTimerRef.current.agent) {
      clearTimeout(captionFadeTimerRef.current.agent);
      captionFadeTimerRef.current.agent = null;
    }

    try {
      await rtc.postEvent({
        type: "response.cancel"
      });
    } catch {
    }
    await new Promise<void>((resolve) => {
      if (pendingPauseCancelRef.current) {
        const prev = pendingPauseCancelRef.current;
        pendingPauseCancelRef.current = null;
        if (prev.timeoutId) {
          clearTimeout(prev.timeoutId);
        }
        prev.resolve();
      }
      const timeoutId = setTimeout(() => {
        if (pendingPauseCancelRef.current) {
          pendingPauseCancelRef.current = null;
          resolve();
        }
      }, 800);
      pendingPauseCancelRef.current = { resolve, timeoutId };
    });
    try {
      await rtc.postEvent({
        type: "session.update",
        source: "frontend",
        message: "agent_paused"
      });
    } catch {
    }
    await sendRealtimeEvent(activeSessionId, {
      type: "hr.agent.pause",
      source: "jobaidemo",
      meetingId: meetingId ?? undefined,
      paused: true
    }).catch(() => undefined);
    if (meetingId) {
      const result = await issueRuntimeCommand(meetingId, {
        type: "agent.pause",
        issuedBy: "hr_ui",
        payload: {
          sessionId: activeSessionId,
          phase: checkpoint.phase,
          questionIndex: checkpoint.questionIndex,
          questionText: checkpoint.questionText,
          totalQuestions: checkpoint.totalQuestions,
          pausedAt: checkpoint.pausedAt
        }
      }).catch(() => undefined);
      if (!result) {
        toast.error("Не удалось отправить команду паузы бота");
      }
    }
    pauseResumeBusyRef.current = false;
    setPauseResumeBusy(false);
    return true;
  }, [buildResumeCheckpoint, ensureClient, meetingId, phase]);

  const resumeAgent = useCallback(async () => {
    agentPausedRef.current = false;
    if (pauseResumeBusyRef.current) {
      return false;
    }
    if (phase !== "connected") {
      return false;
    }
    if (flowPhase === "completed") {
      toast.info("Сессия завершена, продолжение недоступно");
      return false;
    }
    const rtc = ensureClient();
    const activeSessionId = rtc.getSessionId();
    if (!activeSessionId) {
      return false;
    }

    pauseResumeBusyRef.current = true;
    setPauseResumeBusy(true);

    const checkpoint = resumeCheckpointRef.current ?? buildResumeCheckpoint("before_resume");
    resumeCheckpointRef.current = checkpoint;
    setResumeCheckpoint(checkpoint);
    void checkpoint;

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
    }
    try {
      await rtc.postEvent({
        type: "response.create",
        response: {
          modalities: OPENAI_RESPONSE_MODALITIES,
          instructions:
            "Продолжи интервью после паузы. Не повторяй приветствие и intro. Не здоровайся заново. " +
            "Не спрашивай «чем могу помочь». Говори только на русском языке. " +
            `Текущая фаза: ${checkpoint.phase ?? "unknown"}. ` +
            `Текущий индекс вопроса: ${checkpoint.questionIndex ?? "unknown"}. ` +
            `Текущий вопрос: ${checkpoint.questionText ?? "unknown"}. ` +
            `Последняя реплика ассистента: ${checkpoint.lastAssistantText ?? "unknown"}. ` +
            `Последняя реплика кандидата: ${checkpoint.lastCandidateText ?? "unknown"}. ` +
            "Если кандидат ещё не ответил на текущий вопрос — кратко повтори текущий вопрос. " +
            "Если кандидат уже ответил — перейди к следующему вопросу из сценария. " +
            "Не объявляй номер вопроса вслух и не говори «вопрос X из Y»."
        }
      });
    } catch {
      toast.error("Не удалось возобновить агента", {
        description: "Попробуйте ещё раз или перезапустите сессию."
      });
      setAgentPaused(true);
      agentPausedRef.current = true;
      rtc.setAudioInputEnabled(false);
      setAgentInputEnabled(false);
      setAgentState("idle");
      pauseResumeBusyRef.current = false;
      setPauseResumeBusy(false);
      return false;
    }
    await sendRealtimeEvent(activeSessionId, {
      type: "hr.agent.resume",
      source: "jobaidemo",
      meetingId: meetingId ?? undefined,
      paused: false
    }).catch(() => undefined);
    if (meetingId) {
      const result = await issueRuntimeCommand(meetingId, {
        type: "agent.resume",
        issuedBy: "hr_ui",
        payload: {
          sessionId: activeSessionId,
          phase: checkpoint.phase,
          questionIndex: checkpoint.questionIndex,
          questionText: checkpoint.questionText,
          totalQuestions: checkpoint.totalQuestions,
          pausedAt: checkpoint.pausedAt
        }
      }).catch(() => undefined);
      if (!result) {
        toast.error("Не удалось отправить команду возобновления бота");
      }
    }
    pauseResumeBusyRef.current = false;
    setPauseResumeBusy(false);
    return true;
  }, [buildResumeCheckpoint, ensureClient, flowPhase, meetingId, phase]);

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    if (!meetingId || phase !== "connected") {
      queueMicrotask(() => {
        setAvatarReady(false);
        setAvatarActiveSpeaker(null);
        setAvatarDegradationLevel(null);
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
        const runtime = await getRuntimeSnapshot(meetingId);
        const isReady = Boolean(runtime.avatar?.avatarReady);
        const speaker =
          runtime.avatar?.activeSpeaker === "candidate"
            ? "candidate"
            : runtime.avatar?.activeSpeaker === "assistant"
              ? "assistant"
              : null;
        const degradation =
          runtime.avatar?.degradationLevel === "fallback"
            ? "fallback"
            : runtime.avatar?.degradationLevel === "hard"
              ? "hard"
              : runtime.avatar?.degradationLevel === "soft"
                ? "soft"
                : runtime.avatar?.degradationLevel === "none"
                  ? "none"
                  : null;
        if (!cancelled) {
          setTelemetryUnavailable(false);
          setAvatarReady(isReady);
          setAvatarActiveSpeaker(speaker);
          setAvatarDegradationLevel(degradation);
          if (isReady && avatarPollTimerRef.current) {
            clearInterval(avatarPollTimerRef.current);
            avatarPollTimerRef.current = null;
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        // 404 on GET /runtime/:meetingId means meeting is not known to gateway (stale UI).
        if (error instanceof ApiRequestError && error.status === 404) {
          setTelemetryUnavailable(true);
          setAvatarReady(false);
          setAvatarActiveSpeaker(null);
          setAvatarDegradationLevel(null);
          if (avatarPollTimerRef.current) {
            clearInterval(avatarPollTimerRef.current);
            avatarPollTimerRef.current = null;
          }
          return;
        }
        setTelemetryUnavailable(false);
        setAvatarReady(false);
        setAvatarActiveSpeaker(null);
        setAvatarDegradationLevel(null);
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
  }, [phase, meetingId]);

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
                  await postIntroResponseToRtc(
                    rtc,
                    effectiveContext,
                    "reconnect",
                    effectivePromptSettings,
                    {
                      getSessionUpdatedVersion,
                      waitForSessionUpdatedAck
                    }
                  );
                }
              }
            } catch (introErr) {
              void introErr;
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

    // Do not list runtimeRecoveryState in deps: effect rerun would cancel in-flight reconnect and stall UI.
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

    /** New meeting + Realtime peer: only candidate-originated triggerSource values (not HR dashboard). */
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

      if (STREAM_OPENAI_AGENT_MODE_ENABLED) {
        // Stream OpenAI agent mode: browser is not the speaking agent; skip greeting / mic-driven responses.
        rtc.setAudioInputEnabled(false);
        setAgentInputEnabled(false);
        setAgentState("idle");
      }

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
            void statusError;
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
      if (!STREAM_OPENAI_AGENT_MODE_ENABLED) {
        await postIntroResponseToRtc(
          rtc,
          effectiveContext,
          "first",
          effectivePromptSettings,
          {
            getSessionUpdatedVersion,
            waitForSessionUpdatedAck
          }
        );
      }

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
        await rtc
          .postEvent({
            type: "session.update",
            source: "frontend",
            message: "session_stopping"
          })
          .catch(() => undefined);
      }

      const finalStatus = options?.finalStatus ?? "completed";
      await stopMeeting(activeMeetingId, {
        reason: "manual_stop",
        finalStatus,
        metadata: {
          jobAiInterviewId: options?.interviewId ?? activeInterviewId ?? undefined,
          stop_reason: finalStatus === "stopped_during_meeting" ? "manual_bot_stop" : "manual_complete"
        }
      });

      const interviewIdForClose = options?.interviewId ?? activeInterviewId ?? undefined;
      if (interviewIdForClose) {
        try {
          if (finalStatus === "completed") {
            await transitionJobAiToCompleted(interviewIdForClose);
          } else {
            await transitionJobAiToStoppedDuringMeeting(interviewIdForClose);
          }
        } catch (statusError) {
          if (isIgnorableStatusTransitionError(statusError)) {
            void statusError;
          } else {
            setError(statusError instanceof Error ? statusError.message : "Failed to update JobAI status");
          }
        }
        try {
          await linkInterviewSession({
            interviewId: interviewIdForClose,
            meetingId: activeMeetingId,
            sessionId: activeSessionId ?? undefined,
            nullxesStatus: finalStatus
          });
        } catch (statusError) {
          if (isIgnorableStatusTransitionError(statusError)) {
            void statusError;
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

  useEffect(() => {
    const timers = captionFadeTimerRef.current;
    return () => {
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
    voiceProvider,
    meetingId,
    sessionId,
    avatarReady,
    avatarActiveSpeaker,
    avatarDegradationLevel,
    degradationState,
    lastAgentContextTrace,
    rtcState,
    error,
    remoteAudioStream,
    agentInputEnabled,
    agentPaused,
    pauseResumeBusy,
    resumeCheckpoint,
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
    markFailed,
    pauseAgent,
    resumeAgent,
    setObserverTalkIsolation,
    hydrateActiveSession
  };
}
