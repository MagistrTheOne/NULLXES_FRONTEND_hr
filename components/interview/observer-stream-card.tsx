"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CallingState,
  ParticipantView,
  StreamCall,
  StreamTheme,
  StreamVideo,
  StreamVideoClient,
  useCallStateHooks
} from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { InterviewStatusBadge } from "@/components/interview/interview-status-badge";
import { MicIndicator } from "@/components/interview/mic-indicator";
import { issueRuntimeCommand } from "@/lib/api";
import { mapVideoStatus, type VideoConnectionState } from "@/lib/interview-status";
import type { SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";

type StreamTokenResponse = {
  apiKey: string;
  token: string;
  user: {
    id: string;
    name: string;
  };
  callId: string;
  callType: string;
};

type ObserverTalkMode = "off" | "on";
export type ObserverConnectionStatus =
  | "waiting_meeting"
  | "joining"
  | "joined"
  | "no_participants"
  | "error"
  | "idle_hidden";

const OBSERVER_TOKEN_TIMEOUT_MS = 15_000;
const OBSERVER_JOIN_TIMEOUT_MS = 20_000;
const OBSERVER_MAX_ATTEMPTS = 4;
const OBSERVER_RETRY_BACKOFF_MS = 800;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

type ObserverCallBodyProps = {
  localUserId: string;
  onParticipantsDetected?: (hasParticipants: boolean) => void;
};

function ObserverCallBody({ localUserId, onParticipantsDetected }: ObserverCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  const orderedParticipants = useMemo(() => {
    const candidate = participants.find((participant) => participant.userId?.startsWith("candidate-")) ?? null;
    const agent =
      participants.find(
        (participant) =>
          participant.userId?.startsWith("agent-") || participant.userId?.startsWith("agent_")
      ) ?? null;
    const byId = new Set<string>();
    const ordered: typeof participants = [];
    for (const participant of [candidate, agent]) {
      if (!participant?.sessionId || byId.has(participant.sessionId)) {
        continue;
      }
      byId.add(participant.sessionId);
      ordered.push(participant);
    }
    for (const participant of participants) {
      if (!participant.sessionId || participant.userId === localUserId || byId.has(participant.sessionId)) {
        continue;
      }
      byId.add(participant.sessionId);
      ordered.push(participant);
    }
    return ordered.slice(0, 4);
  }, [localUserId, participants]);

  useEffect(() => {
    onParticipantsDetected?.(orderedParticipants.length > 0);
  }, [onParticipantsDetected, orderedParticipants.length]);

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Подключение наблюдателя…</div>;
  }

  if (orderedParticipants.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание участников</div>;
  }

  return (
    <div className="grid h-full w-full grid-cols-1 gap-2 p-2 sm:grid-cols-2">
      {orderedParticipants.map((participant) => (
        <div key={participant.sessionId} className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
          <ParticipantView participant={participant} trackType="videoTrack" />
        </div>
      ))}
    </div>
  );
}

type ObserverStreamCardProps = {
  participantName: string;
  meetingId: string | null;
  enabled: boolean;
  visible: boolean;
  talkMode: ObserverTalkMode;
  onVisibleChange?: (nextVisible: boolean) => void;
  onTalkModeChange?: (nextTalkMode: ObserverTalkMode) => void;
  allowVisibilityToggle?: boolean;
  allowTalkToggle?: boolean;
  mutePlayback?: boolean;
  title?: string;
  onStatusChange?: (status: ObserverConnectionStatus) => void;
  sessionEnded?: boolean;
  uiState?: SessionUIState;
  /** Подписанная ссылка наблюдателя (query после /join/spectator/...); усиливает выдачу Stream token. */
  spectatorJoinToken?: string | null;
};

export function ObserverStreamCard({
  participantName,
  meetingId,
  enabled,
  visible,
  talkMode,
  onVisibleChange,
  onTalkModeChange,
  allowVisibilityToggle = true,
  allowTalkToggle = true,
  mutePlayback = true,
  title = "Наблюдатель",
  onStatusChange,
  sessionEnded = false,
  uiState,
  spectatorJoinToken = null
}: ObserverStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasParticipants, setHasParticipants] = useState<boolean | null>(null);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const sessionSuffixRef = useRef<string>(Math.random().toString(36).slice(2, 8));
  const connectEpochRef = useRef(0);

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const canConnect = enabled && visible && Boolean(meetingId) && !ended;
  const status: ObserverConnectionStatus = useMemo(() => {
    if (!visible && allowVisibilityToggle) {
      return "idle_hidden";
    }
    if (error) {
      return "error";
    }
    if (!meetingId || !enabled) {
      return "waiting_meeting";
    }
    if (busy) {
      return "joining";
    }
    if (call && hasParticipants === false) {
      return "no_participants";
    }
    if (call) {
      return "joined";
    }
    return "waiting_meeting";
  }, [allowVisibilityToggle, busy, call, canConnect, enabled, error, hasParticipants, meetingId, visible]);

  /**
   * Маппинг внутреннего ObserverConnectionStatus в локальный VideoConnectionState
   * (унифицированная семантика с остальной системой статусов).
   */
  const videoState: VideoConnectionState = useMemo(() => {
    if (ended) return "idle";
    if (status === "idle_hidden") return "hidden";
    if (status === "error") return "failed";
    if (status === "joining") return "connecting";
    if (status === "joined") return "connected";
    if (status === "no_participants") return "no_participants";
    return "idle";
  }, [ended, status]);

  const videoStatusView = useMemo(() => mapVideoStatus(videoState), [videoState]);
  const statusHint = useMemo(() => {
    if (ended) {
      return "Сессия завершена. Повторное подключение недоступно.";
    }
    if (!meetingId || !enabled) {
      return "Интервью еще не запущено. Подключение доступно после активации сессии кандидата.";
    }
    if (busy) {
      return "Подключаем наблюдателя к активной сессии...";
    }
    if (error) {
      return "Подключение не удалось. Повторите попытку.";
    }
    return "Наблюдатель подключен к активной сессии.";
  }, [busy, enabled, ended, error, meetingId]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    const root = streamViewportRef.current;
    if (!root) {
      return;
    }
    const syncMedia = () => {
      root.querySelectorAll("audio, video").forEach((element) => {
        const media = element as HTMLMediaElement;
        media.muted = mutePlayback;
        media.volume = mutePlayback ? 0 : 1;
      });
    };
    syncMedia();
    const observer = new MutationObserver(() => syncMedia());
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [call, mutePlayback]);

  const disconnectStream = useCallback(async () => {
    connectEpochRef.current += 1;
    if (call) {
      await call.leave().catch(() => undefined);
    }
    if (client) {
      await client.disconnectUser().catch(() => undefined);
    }
    setCall(null);
    setClient(null);
    setLocalUserId(null);
  }, [call, client]);

  useEffect(() => {
    if (ended) {
      void disconnectStream();
    }
  }, [disconnectStream, ended]);

  const startStream = useCallback(async () => {
    if (ended) {
      return;
    }
    if (!meetingId) {
      return;
    }
    setBusy(true);
    setError(null);
    const epoch = ++connectEpochRef.current;
    // Runtime command is advisory; never block Stream join on it.
    void issueRuntimeCommand(meetingId, {
      type: "observer.reconnect",
      issuedBy: "observer_ui",
      payload: { participantName }
    }).catch(() => undefined);
    try {
      const observerUserId = `observer-${meetingId}-${sessionSuffixRef.current}`;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= OBSERVER_MAX_ATTEMPTS; attempt += 1) {
        let streamClient: StreamVideoClient | null = null;
        let streamCall: ReturnType<StreamVideoClient["call"]> | null = null;
        try {
          const tokenAbort = new AbortController();
          const abortTimer = setTimeout(() => tokenAbort.abort(), OBSERVER_TOKEN_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch("/api/stream/token", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              signal: tokenAbort.signal,
              body: JSON.stringify({
                role: "spectator",
                meetingId,
                userId: observerUserId,
                userName: participantName,
                ...(spectatorJoinToken ? { joinToken: spectatorJoinToken } : {})
              })
            });
          } finally {
            clearTimeout(abortTimer);
          }

          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
            if (response.status === 409 && payload.code === "meeting.not_active") {
              throw new Error("meeting.not_active");
            }
            throw new Error(payload.message ?? "Failed to issue observer stream token");
          }

          const payload = (await response.json()) as StreamTokenResponse;
          // См. avatar-stream-card: переопределяем axios-timeout Stream SDK
          // с дефолтных 5с на 60с, чтобы observer не падал посреди сессии
          // сообщением «timeout of 5000ms exceeded».
          streamClient = new StreamVideoClient({
            apiKey: payload.apiKey,
            token: payload.token,
            user: payload.user,
            options: { timeout: 60_000 }
          });
          streamCall = streamClient.call(payload.callType, payload.callId);
          await streamCall.camera.disable().catch(() => undefined);
          await streamCall.microphone.disable().catch(() => undefined);
          // Allow observer to create the call to avoid race conditions
          // when spectator joins slightly earlier than candidate/HR.
          await withTimeout(
            streamCall.join({ create: true, video: false }),
            OBSERVER_JOIN_TIMEOUT_MS,
            "Observer stream join timeout"
          );
          await streamCall.camera.disable().catch(() => undefined);
          await streamCall.microphone.disable().catch(() => undefined);

          if (connectEpochRef.current !== epoch) {
            await streamCall.leave().catch(() => undefined);
            await streamClient.disconnectUser().catch(() => undefined);
            return;
          }
          setClient(streamClient);
          setCall(streamCall);
          setLocalUserId(payload.user.id);
          setHasParticipants(null);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error("Failed to start observer stream");
          await streamCall?.leave().catch(() => undefined);
          await streamClient?.disconnectUser().catch(() => undefined);
          const lower = lastError.message.toLowerCase();
          const transient =
            lower.includes("timeout") ||
            lower.includes("timed out") ||
            lower.includes("failed to fetch") ||
            lower.includes("network") ||
            lower.includes("abort") ||
            lower.includes("meeting.not_active") ||
            lower.includes("сессия не активна");
          if (!transient || attempt >= OBSERVER_MAX_ATTEMPTS) {
            if (lower.includes("meeting.not_active") || lower.includes("сессия не активна")) {
              throw new Error("Сессия еще запускается. Повторите подключение через 2-3 секунды.");
            }
            throw lastError;
          }
          const backoffMs = OBSERVER_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
          await wait(backoffMs);
        }
      }

      if (lastError) {
        throw lastError;
      }
    } catch (err) {
      if (connectEpochRef.current !== epoch) {
        return;
      }
      const msg = err instanceof Error ? err.message : "Failed to start observer stream";
      setError(msg);
      toast.error("Видео наблюдателя", { description: msg });
      // Let auto-join attempt again on next render cycle after transient failures.
      autoJoinAttemptForRef.current = null;
    } finally {
      if (connectEpochRef.current === epoch) {
        setBusy(false);
      }
    }
  }, [ended, meetingId, participantName, spectatorJoinToken]);

  useEffect(() => {
    if (!canConnect || call || busy || error) {
      return;
    }
    const autoJoinKey = `${meetingId ?? "no-meeting"}:${spectatorJoinToken ?? ""}`;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, canConnect, error, meetingId, spectatorJoinToken, startStream]);

  useEffect(() => {
    if (canConnect) {
      return;
    }
    void disconnectStream();
  }, [canConnect, disconnectStream]);

  useEffect(() => {
    if (!call || !allowTalkToggle) {
      return;
    }
    if (talkMode === "on") {
      void call.microphone.enable().catch(() => undefined);
      return;
    }
    void call.microphone.disable().catch(() => undefined);
  }, [allowTalkToggle, call, talkMode]);

  useEffect(() => {
    if ((status === "joining" || status === "waiting_meeting") && talkMode === "on") {
      onTalkModeChange?.("off");
    }
  }, [onTalkModeChange, status, talkMode]);

  useEffect(
    () => () => {
      void disconnectStream();
    },
    [disconnectStream]
  );

  const showJoinLoader = busy && visible;

  return (
    <StreamParticipantShell
      title={title}
      videoRef={streamViewportRef}
      videoClassName={cn(
        (!visible || !client || !call) && "bg-slate-300/70",
        ended && "pointer-events-none opacity-70"
      )}
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{participantName}</p>
            <InterviewStatusBadge status={videoStatusView} />
          </div>
          {allowTalkToggle && visible ? (
            <MicIndicator active={talkMode === "on" && Boolean(call)} />
          ) : null}
          <div className="flex min-h-10 flex-wrap gap-2">
            {allowVisibilityToggle ? (
              <Button
                type="button"
                variant="secondary"
                className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:opacity-50"
                disabled={ended}
                onClick={() => onVisibleChange?.(!visible)}
              >
                {visible ? "Скрыть видео" : "Показать видео"}
              </Button>
            ) : null}
            {allowTalkToggle ? (
              <Button
                type="button"
                variant={talkMode === "on" ? "destructive" : "outline"}
                className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:opacity-50"
                disabled={!call || ended}
                onClick={() => onTalkModeChange?.(talkMode === "on" ? "off" : "on")}
              >
                {talkMode === "on" ? "Выключить микрофон" : "Включить микрофон"}
              </Button>
            ) : null}
            {!call && canConnect ? (
              <Button
                type="button"
                className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                onClick={() => void startStream()}
                disabled={busy || ended}
                title={
                  ended
                    ? "Сессия завершена"
                    : busy
                      ? "Выполняется подключение"
                      : "Подключить наблюдателя к активной сессии"
                }
              >
                Подключиться
              </Button>
            ) : null}
          </div>
        </>
      }
      error={error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
    >
      {!visible && allowVisibilityToggle ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-sm font-medium text-slate-700">{videoStatusView.label}</p>
          <p className="text-xs text-slate-600">Включите видео, чтобы видеть кандидата и агента</p>
        </div>
      ) : client && call && localUserId ? (
        <div className={cn("h-full w-full", ended && "opacity-80")}>
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <ObserverCallBody localUserId={localUserId} onParticipantsDetected={setHasParticipants} />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          {showJoinLoader ? <Loader2 className="h-7 w-7 shrink-0 animate-spin text-slate-600" aria-hidden /> : null}
          <p className="text-sm font-medium text-slate-700">{videoStatusView.label}</p>
          <p className="max-w-[280px] text-xs text-slate-600">{statusHint}</p>
        </div>
      )}
    </StreamParticipantShell>
  );
}
