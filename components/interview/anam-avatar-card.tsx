"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, AnamEvent, type AnamClient } from "@anam-ai/js-sdk";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { Badge } from "@/components/ui/badge";
import type { SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";
import type { AgentSpeechEvent } from "@/hooks/use-interview-session";

const AVATAR_PLACEHOLDER_SRC = "/anna.jpg";
const ANAM_STARTUP_TIMEOUT_MS = 10_000;
const DEBUG_ANAM_AVATAR = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";

type AnamSessionTokenResponse = {
  sessionToken: string;
  provider: "anam";
  meetingId: string;
  sessionId: string | null;
};

type AnamAvatarStatus = "idle" | "connecting" | "ready" | "speaking" | "fallback" | "ended";
export type AnamAvailability = "idle" | "connecting" | "live" | "fallback" | "ended";

type AnamAvatarCardProps = {
  participantName: string;
  enabled: boolean;
  meetingId: string | null;
  realtimeSessionId?: string | null;
  agentSpeechEvent?: AgentSpeechEvent | null;
  showStatusBadge?: boolean;
  showPauseAI?: boolean;
  onTogglePauseAI?: () => void;
  pauseAIDisabled?: boolean;
  aiPaused?: boolean;
  pauseResumeCopy?: "pause" | "stop_bot";
  showStopAI?: boolean;
  onStopAI?: () => void;
  stopAIDisabled?: boolean;
  sessionEnded?: boolean;
  uiState?: SessionUIState;
  emphasizePrimary?: boolean;
  mobilePip?: boolean;
  onAvailabilityChange?: (availability: AnamAvailability) => void;
};

function logAnamAvatarEvent(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_ANAM_AVATAR) return;
  if (typeof console === "undefined") return;
  console.info(JSON.stringify({ msg: event, event, ...payload }));
}

function shouldFallbackFromWarning(message: string): boolean {
  return /quota|limit|credit|billing|expired|session|disconnect|unavailable/i.test(message);
}

function AnamAvatarPlaceholder({ emphasize }: { emphasize?: boolean }) {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Image
        src={AVATAR_PLACEHOLDER_SRC}
        alt="HR ассистент NULLXES"
        fill
        sizes="(max-width: 1024px) 100vw, 480px"
        priority
        className={cn("object-cover object-center", emphasize ? "scale-[1.02]" : undefined)}
      />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/35 via-transparent to-transparent" />
    </div>
  );
}

export function AnamAvatarCard({
  participantName,
  enabled,
  meetingId,
  realtimeSessionId = null,
  agentSpeechEvent = null,
  showStatusBadge = true,
  showPauseAI = false,
  pauseResumeCopy = "pause",
  showStopAI = false,
  onStopAI,
  stopAIDisabled = false,
  onTogglePauseAI,
  pauseAIDisabled = false,
  aiPaused = false,
  sessionEnded = false,
  uiState,
  emphasizePrimary = true,
  mobilePip = false,
  onAvailabilityChange
}: AnamAvatarCardProps) {
  const ended = Boolean(sessionEnded) || uiState === "completed";
  const videoElementId = useMemo(() => `anam-hr-avatar-${meetingId ?? "idle"}`, [meetingId]);
  const [status, setStatus] = useState<AnamAvatarStatus>("idle");
  const [inlineStatus, setInlineStatus] = useState<string | null>(null);
  const [anamReady, setAnamReady] = useState(false);
  const clientRef = useRef<AnamClient | null>(null);
  const connectInFlightRef = useRef(false);
  const connectEpochRef = useRef(0);
  const startupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedSpeechSeqRef = useRef(0);
  const activeTalkStreamRef = useRef<{ itemId: string; stream: ReturnType<AnamClient["createTalkMessageStream"]> } | null>(null);

  const hrStatusLabel = useMemo(() => {
    if (ended || status === "ended") return "Сессия завершена";
    if (status === "ready" || status === "fallback") return "В эфире";
    if (status === "speaking") return "Говорит";
    if (status === "connecting") return "Подключаемся…";
    if (!enabled || !meetingId) return "Ожидаем запуск";
    return "Ожидаем запуск";
  }, [enabled, ended, meetingId, status]);

  const clearStartupTimeout = useCallback(() => {
    if (startupTimeoutRef.current) {
      clearTimeout(startupTimeoutRef.current);
      startupTimeoutRef.current = null;
    }
  }, []);

  const reportAvailability = useCallback((availability: AnamAvailability) => {
    onAvailabilityChange?.(availability);
  }, [onAvailabilityChange]);

  const disconnect = useCallback(async (availability?: AnamAvailability) => {
    connectEpochRef.current += 1;
    clearStartupTimeout();
    activeTalkStreamRef.current = null;
    processedSpeechSeqRef.current = 0;
    setAnamReady(false);
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      await client.stopStreaming().catch(() => undefined);
    }
    setInlineStatus(null);
    setStatus(ended ? "ended" : availability === "fallback" ? "fallback" : "idle");
    reportAvailability(availability ?? (ended ? "ended" : "idle"));
  }, [clearStartupTimeout, ended, reportAvailability]);

  const enterFallback = useCallback(async (reason: string, payload: Record<string, unknown> = {}) => {
    logAnamAvatarEvent("hr_avatar_overlay_fallback", { meetingId, sessionId: realtimeSessionId, reason, ...payload });
    await disconnect("fallback");
  }, [disconnect, meetingId, realtimeSessionId]);

  const processSpeechEvent = useCallback(async (event: AgentSpeechEvent) => {
    const client = clientRef.current;
    if (!client || !anamReady) {
      return;
    }

    if (aiPaused) {
      return;
    }

    const itemId = event.itemId || "current";
    if (!event.done) {
      const delta = event.delta ?? "";
      if (!delta) return;
      let active = activeTalkStreamRef.current;
      if (!active || active.itemId !== itemId || !active.stream.isActive()) {
        active = {
          itemId,
          stream: client.createTalkMessageStream(`openai-${itemId}-${event.seq}`)
        };
        activeTalkStreamRef.current = active;
        setStatus("speaking");
        logAnamAvatarEvent("anam_avatar_talk_started", { meetingId, sessionId: realtimeSessionId, itemId });
      }
      await active.stream.streamMessageChunk(delta, false);
      return;
    }

    const active = activeTalkStreamRef.current;
    if (active && active.itemId === itemId && active.stream.isActive()) {
      await active.stream.endMessage();
      activeTalkStreamRef.current = null;
      setStatus("ready");
      logAnamAvatarEvent("anam_avatar_talk_done", { meetingId, sessionId: realtimeSessionId, itemId });
      return;
    }

    const text = event.text?.trim();
    if (text) {
      setStatus("speaking");
      logAnamAvatarEvent("anam_avatar_talk_started", { meetingId, sessionId: realtimeSessionId, itemId, fallback: "talk" });
      await client.talk(text);
      setStatus("ready");
      logAnamAvatarEvent("anam_avatar_talk_done", { meetingId, sessionId: realtimeSessionId, itemId, fallback: "talk" });
    }
  }, [aiPaused, anamReady, meetingId, realtimeSessionId]);

  const startAnam = useCallback(async () => {
    if (!enabled || !meetingId || ended) return;
    if (connectInFlightRef.current || clientRef.current) return;

    connectInFlightRef.current = true;
    const epoch = ++connectEpochRef.current;
    setStatus("connecting");
    setInlineStatus("Подключаемся…");
    reportAvailability("connecting");
    logAnamAvatarEvent("anam_avatar_token_requested", { meetingId, sessionId: realtimeSessionId });

    try {
      clearStartupTimeout();
      startupTimeoutRef.current = setTimeout(() => {
        if (connectEpochRef.current === epoch) {
          void enterFallback("startup_timeout");
        }
      }, ANAM_STARTUP_TIMEOUT_MS);

      const response = await fetch("/api/hr-avatar/session-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId, sessionId: realtimeSessionId })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? `Anam token failed: ${response.status}`);
      }

      const payload = (await response.json()) as AnamSessionTokenResponse;
      if (connectEpochRef.current !== epoch) {
        return;
      }

      const client = createClient(payload.sessionToken, {
        disableInputAudio: false,
        voiceDetection: {
          endOfSpeechSensitivity: 0.5
        }
      });
      clientRef.current = client;

      client.addListener(AnamEvent.SESSION_READY, (anamSessionId: string) => {
        logAnamAvatarEvent("anam_avatar_session_ready", { meetingId, sessionId: realtimeSessionId, anamSessionId });
      });
      client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
        clearStartupTimeout();
        setAnamReady(true);
        setStatus("ready");
        setInlineStatus(null);
        reportAvailability("live");
        logAnamAvatarEvent("anam_avatar_video_started", { meetingId, sessionId: realtimeSessionId });
      });
      client.addListener(AnamEvent.USER_SPEECH_STARTED, (correlationId: string) => {
        logAnamAvatarEvent("anam_avatar_user_speech_started", { meetingId, sessionId: realtimeSessionId, correlationId });
      });
      client.addListener(AnamEvent.USER_SPEECH_ENDED, (correlationId: string) => {
        logAnamAvatarEvent("anam_avatar_user_speech_ended", { meetingId, sessionId: realtimeSessionId, correlationId });
      });
      client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages: unknown[]) => {
        logAnamAvatarEvent("anam_avatar_message_history_updated", {
          meetingId,
          sessionId: realtimeSessionId,
          messageCount: Array.isArray(messages) ? messages.length : 0
        });
      });
      client.addListener(AnamEvent.CONNECTION_CLOSED, (reason: unknown, details?: string) => {
        logAnamAvatarEvent("anam_avatar_connection_closed", { meetingId, sessionId: realtimeSessionId, reason, details });
        if (!ended) {
          void enterFallback("connection_closed", { reason, details });
        }
      });
      client.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, (correlationId: string) => {
        activeTalkStreamRef.current = null;
        setStatus("ready");
        logAnamAvatarEvent("anam_avatar_talk_interrupted", { meetingId, sessionId: realtimeSessionId, correlationId });
      });
      client.addListener(AnamEvent.SERVER_WARNING, (message: string) => {
        logAnamAvatarEvent("anam_avatar_warning", { meetingId, sessionId: realtimeSessionId, message });
        if (shouldFallbackFromWarning(message)) {
          void enterFallback("server_warning", { message });
        }
      });

      await client.streamToVideoElement(videoElementId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Не удалось подключить Anam";
      logAnamAvatarEvent("anam_avatar_error", { meetingId, sessionId: realtimeSessionId, message });
      await enterFallback("start_failed", { message });
    } finally {
      connectInFlightRef.current = false;
    }
  }, [clearStartupTimeout, enabled, ended, enterFallback, meetingId, realtimeSessionId, reportAvailability, videoElementId]);

  useEffect(() => {
    if (!enabled || !meetingId || ended) {
      void disconnect(ended ? "ended" : "idle");
      return;
    }
    void startAnam();
  }, [disconnect, enabled, ended, meetingId, startAnam]);

  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  useEffect(() => {
    if (!agentSpeechEvent || agentSpeechEvent.seq <= processedSpeechSeqRef.current) {
      return;
    }
    processedSpeechSeqRef.current = agentSpeechEvent.seq;
    void processSpeechEvent(agentSpeechEvent).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logAnamAvatarEvent("anam_avatar_error", { meetingId, sessionId: realtimeSessionId, message });
    });
  }, [agentSpeechEvent, meetingId, processSpeechEvent, realtimeSessionId]);

  return (
    <StreamParticipantShell
      title="HR аватар"
      compact={mobilePip}
      videoClassName={cn(
        status !== "ready" && status !== "speaking" && "bg-slate-300/70",
        emphasizePrimary && uiState === "active" && "ring-2 ring-indigo-400/35 ring-offset-2 ring-offset-[#d9dee7]",
        ended && "pointer-events-none opacity-70"
      )}
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{participantName}</p>
            {showStatusBadge ? (
              <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                <span className="mr-1 text-indigo-600" aria-hidden>
                  ●
                </span>
                {hrStatusLabel}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-h-10 flex-wrap items-stretch gap-2">
            {showPauseAI && onTogglePauseAI ? (
              <button
                type="button"
                disabled={pauseAIDisabled || ended}
                onClick={onTogglePauseAI}
                className={cn(
                  "h-10 min-h-10 rounded-xl border px-4 text-sm font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                  aiPaused
                    ? "border-emerald-300/80 bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-400"
                    : "border-amber-300/80 bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-400"
                )}
                title={aiPaused ? "Возобновить ответы HR аватара" : "Приостановить ответы HR аватара"}
              >
                {pauseResumeCopy === "stop_bot"
                  ? aiPaused
                    ? "Продолжить бота"
                    : "Стоп бота"
                  : aiPaused
                    ? "Продолжить"
                    : "Пауза"}
              </button>
            ) : null}
            {showStopAI && onStopAI ? (
              <button
                type="button"
                disabled={stopAIDisabled || ended}
                onClick={onStopAI}
                className="h-10 min-h-10 w-full rounded-xl border border-rose-300/80 bg-rose-600 px-4 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] transition hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Завершить интервью
              </button>
            ) : ended ? (
              <p className="w-full text-xs text-slate-600">Интервью завершено, управление отключено.</p>
            ) : null}
          </div>
        </>
      }
    >
      {ended ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-sm font-medium text-slate-700">{hrStatusLabel}</p>
        </div>
      ) : (
        <div className="relative h-full w-full">
          <AnamAvatarPlaceholder emphasize={emphasizePrimary} />
          <video
            id={videoElementId}
            autoPlay
            playsInline
            className={cn(
              "absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-300",
              anamReady ? "opacity-100" : "opacity-0"
            )}
          />
          {!anamReady ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 px-4 pb-3 text-center">
              {status === "connecting" ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-white/90" aria-hidden /> : null}
              <p className="rounded-full bg-black/45 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
                {hrStatusLabel}
              </p>
              {inlineStatus ? (
                <p className="rounded-full bg-black/35 px-3 py-1 text-[11px] text-white/90 backdrop-blur-sm">
                  {inlineStatus}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </StreamParticipantShell>
  );
}
