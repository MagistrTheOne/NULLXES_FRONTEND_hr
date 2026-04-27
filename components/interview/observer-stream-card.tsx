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
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
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

type StreamTokenErrorPayload = {
  message?: string;
  code?: string;
};

type ObserverTalkMode = "off" | "on";
export type ObserverConnectionStatus =
  | "waiting_meeting"
  | "joining"
  | "joined"
  | "no_participants"
  | "error"
  | "idle_hidden";
type ObserverConnectionPhase = "connecting" | "connected" | "reconnecting" | "failed";

const OBSERVER_TOKEN_TIMEOUT_MS = 15_000;
const OBSERVER_JOIN_TIMEOUT_MS = 20_000;
const OBSERVER_MAX_ATTEMPTS = 4;
const OBSERVER_RETRY_BACKOFF_MS = 800;
const OBSERVER_RECONNECT_LOCK_MS = 1_500;
const OBSERVER_NO_PARTICIPANTS_GRACE_MS = 3_500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObserverTicketError(payload: StreamTokenErrorPayload): boolean {
  const code = (payload.code ?? "").toLowerCase();
  return (
    code.startsWith("spectator.ticket_") ||
    code === "observer_ticket_invalid" ||
    code === "observer_ticket_expired" ||
    code === "observer_ticket_consumed"
  );
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
  sessionMirrorLayout?: boolean;
};

function ObserverCallBody({ localUserId, onParticipantsDetected, sessionMirrorLayout = false }: ObserverCallBodyProps) {
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

  if (!sessionMirrorLayout) {
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

  const candidate = orderedParticipants[0] ?? null;
  const avatar = orderedParticipants[1] ?? null;
  const extra = orderedParticipants.slice(2, 4);

  return (
    <div className="grid h-full w-full grid-cols-1 gap-2 p-2 lg:grid-cols-3">
      <div className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50 lg:col-span-2">
        {candidate ? (
          <ParticipantView participant={candidate} trackType="videoTrack" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание кандидата</div>
        )}
      </div>
      <div className="grid gap-2 lg:grid-rows-2">
        <div className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
          {avatar ? (
            <ParticipantView participant={avatar} trackType="videoTrack" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание HR аватара</div>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {extra.map((participant) => (
            <div key={participant.sessionId} className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
              <ParticipantView participant={participant} trackType="videoTrack" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type ObserverStreamCardProps = {
  participantName: string;
  meetingId: string | null;
  streamCallId?: string | null;
  streamCallType?: string | null;
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
  /** Одноразовый observer session ticket, выданный backend на join-шаге. */
  spectatorObserverTicket?: string | null;
  /** Stable spectator key for reconnect identity (if available from URL/parent). */
  spectatorViewerKey?: string | null;
  /** Компоновка в стиле "полотно сессии": кандидат слева, аватар справа. */
  sessionMirrorLayout?: boolean;
  /** Мини self-view наблюдателя (локальная камера/микрофон) поверх потока. */
  showSelfPreview?: boolean;
  /** Точный статус ожидания из родительского orchestration-слоя spectator page. */
  waitingReason?: string | null;
};

export function ObserverStreamCard({
  participantName,
  meetingId,
  streamCallId = null,
  streamCallType = null,
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
  spectatorJoinToken = null,
  spectatorObserverTicket = null,
  spectatorViewerKey = null,
  sessionMirrorLayout = false,
  showSelfPreview = false,
  waitingReason = null
}: ObserverStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasParticipants, setHasParticipants] = useState<boolean | null>(null);
  const [selfPreviewStream, setSelfPreviewStream] = useState<MediaStream | null>(null);
  const [selfCameraEnabled, setSelfCameraEnabled] = useState(true);
  const [selfMicEnabled, setSelfMicEnabled] = useState(true);
  const [selfPreviewError, setSelfPreviewError] = useState<string | null>(null);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const selfPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const connectEpochRef = useRef(0);
  const [persistedViewerKey, setPersistedViewerKey] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ObserverConnectionPhase>("connecting");
  const reconnectLockUntilRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const noParticipantsReconnectDoneRef = useRef<string | null>(null);

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const canConnect =
    enabled &&
    visible &&
    Boolean(meetingId) &&
    Boolean(streamCallId?.trim()) &&
    Boolean(streamCallType?.trim()) &&
    !ended;
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
      return waitingReason ?? "Интервью еще не запущено. Подключение доступно после активации сессии кандидата.";
    }
    if (!streamCallId || !streamCallType) {
      return waitingReason ?? "Ждём конфигурацию Stream call от runtime.";
    }
    if (busy) {
      if (connectionPhase === "reconnecting") {
        return "Восстанавливаем подключение наблюдателя...";
      }
      return "Подключаем наблюдателя к активной сессии...";
    }
    if (error) {
      return "Подключение не удалось. Повторите попытку.";
    }
    if (connectionPhase === "connected") {
      return "Наблюдатель подключен к активной сессии.";
    }
    return "Наблюдатель подключен к активной сессии.";
  }, [busy, connectionPhase, enabled, ended, error, meetingId, streamCallId, streamCallType, waitingReason]);

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

  const cleanupSelfPreview = useCallback(() => {
    setSelfPreviewStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }, []);

  const ensureSelfPreview = useCallback(async () => {
    if (!showSelfPreview || selfPreviewStream) {
      return;
    }
    try {
      setSelfPreviewError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = selfCameraEnabled;
      });
      stream.getAudioTracks().forEach((track) => {
        track.enabled = selfMicEnabled;
      });
      setSelfPreviewStream(stream);
    } catch (error) {
      // Self-preview is optional in observer mode; do not block session.
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("notallowed")) {
        setSelfPreviewError("Нет доступа к камере/микрофону. Разрешите доступ в браузере.");
      } else if (message.toLowerCase().includes("notfound")) {
        setSelfPreviewError("Камера или микрофон не найдены.");
      } else {
        setSelfPreviewError("Self-preview недоступен. Можно продолжать наблюдение без локального видео.");
      }
    }
  }, [selfCameraEnabled, selfMicEnabled, selfPreviewStream, showSelfPreview]);

  useEffect(() => {
    if (showSelfPreview) {
      return;
    }
    cleanupSelfPreview();
    setSelfPreviewError(null);
  }, [cleanupSelfPreview, showSelfPreview]);

  useEffect(() => {
    const element = selfPreviewVideoRef.current;
    if (!element || !selfPreviewStream) {
      return;
    }
    element.srcObject = selfPreviewStream;
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [selfPreviewStream]);

  useEffect(() => {
    if (!selfPreviewStream) {
      return;
    }
    selfPreviewStream.getVideoTracks().forEach((track) => {
      track.enabled = selfCameraEnabled;
    });
    selfPreviewStream.getAudioTracks().forEach((track) => {
      track.enabled = selfMicEnabled;
    });
  }, [selfCameraEnabled, selfMicEnabled, selfPreviewStream]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setTabId(null);
      return;
    }
    const storageKey = "nullxes:spectator:tabId";
    const existing = window.sessionStorage.getItem(storageKey)?.trim() ?? "";
    if (existing) {
      setTabId(existing);
      return;
    }
    const generated =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(storageKey, generated);
    setTabId(generated);
  }, []);

  useEffect(() => {
    const explicitViewerKey = spectatorViewerKey?.trim();
    if (explicitViewerKey) {
      setPersistedViewerKey(explicitViewerKey);
      return;
    }
    if (!meetingId || typeof window === "undefined") {
      setPersistedViewerKey(null);
      return;
    }
    const storageKey = `nullxes:spectator:viewerKey:${meetingId}`;
    const existing = window.localStorage.getItem(storageKey)?.trim() ?? "";
    if (existing) {
      setPersistedViewerKey(existing);
      return;
    }
    const generated = `viewer-${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(storageKey, generated);
    setPersistedViewerKey(generated);
  }, [meetingId, spectatorViewerKey]);

  const refreshObserverTicket = useCallback(async (): Promise<string | null> => {
    const joinToken = spectatorJoinToken?.trim();
    if (!joinToken) {
      return null;
    }
    const response = await fetch(
      `/api/gateway/join/spectator/${encodeURIComponent(joinToken)}/session-ticket`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" }
      }
    ).catch(() => null);

    if (!response?.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => ({}))) as { observerTicket?: unknown };
    const observerTicket =
      typeof payload.observerTicket === "string" ? payload.observerTicket.trim() : "";
    return observerTicket.length > 0 ? observerTicket : null;
  }, [spectatorJoinToken]);

  useEffect(() => {
    if (ended) {
      void disconnectStream();
      cleanupSelfPreview();
    }
  }, [cleanupSelfPreview, disconnectStream, ended]);

  const startStream = useCallback(async () => {
    if (ended) {
      return;
    }
    if (!meetingId) {
      return;
    }
    if (connectInFlightRef.current) {
      return;
    }
    const now = Date.now();
    if (reconnectLockUntilRef.current > now) {
      return;
    }
    reconnectLockUntilRef.current = now + OBSERVER_RECONNECT_LOCK_MS;
    connectInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setConnectionPhase(call ? "reconnecting" : "connecting");
    const epoch = ++connectEpochRef.current;
    // Runtime command is advisory; never block Stream join on it.
    void issueRuntimeCommand(meetingId, {
      type: "observer.reconnect",
      issuedBy: "observer_ui",
      payload: { participantName }
    }).catch(() => undefined);
    try {
      let lastError: Error | null = null;
      let activeObserverTicket = spectatorObserverTicket?.trim() || null;
      let refreshedTicketOnce = false;

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
                callId: streamCallId,
                callType: streamCallType,
                userName: participantName,
                ...(persistedViewerKey
                  ? { viewerKey: tabId ? `${persistedViewerKey}:${tabId}` : persistedViewerKey }
                  : {}),
                ...(spectatorJoinToken ? { joinToken: spectatorJoinToken } : {}),
                ...(activeObserverTicket ? { observerTicket: activeObserverTicket } : {})
              })
            });
          } finally {
            clearTimeout(abortTimer);
          }

          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as StreamTokenErrorPayload;
            if (response.status === 409 && payload.code === "meeting.not_active") {
              throw new Error("meeting.not_active");
            }
            if (!refreshedTicketOnce && isObserverTicketError(payload)) {
              refreshedTicketOnce = true;
              const refreshed = await refreshObserverTicket();
              if (refreshed) {
                activeObserverTicket = refreshed;
                throw new Error("observer.ticket.refreshed_retry");
              }
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
          await withTimeout(
            // Observer is read-only and must never create ghost calls.
            // Join only existing call created by candidate/HR flow.
            streamCall.join({ create: false, video: false }),
            OBSERVER_JOIN_TIMEOUT_MS,
            "Observer stream join timeout"
          );
          // Audio-first fallback: observer must continue even if video negotiation is flaky.
          await streamCall.microphone.disable().catch(() => undefined);
          await streamCall.camera.disable().catch(() => undefined);
          setConnectionPhase("connected");

          if (connectEpochRef.current !== epoch) {
            await streamCall.leave().catch(() => undefined);
            await streamClient.disconnectUser().catch(() => undefined);
            return;
          }
          setClient(streamClient);
          setCall(streamCall);
          setLocalUserId(payload.user.id);
          setHasParticipants(null);
          void ensureSelfPreview();
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
            lower.includes("observer.ticket.refreshed_retry") ||
            lower.includes("meeting.not_active") ||
            lower.includes("video") ||
            lower.includes("media") ||
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
      setConnectionPhase("failed");
      toast.error("Видео наблюдателя", { description: msg });
      // Let auto-join attempt again on next render cycle after transient failures.
      autoJoinAttemptForRef.current = null;
    } finally {
      connectInFlightRef.current = false;
      if (connectEpochRef.current === epoch) {
        setBusy(false);
      }
    }
  }, [
    ended,
    ensureSelfPreview,
    streamCallId,
    streamCallType,
    meetingId,
    participantName,
    refreshObserverTicket,
    persistedViewerKey,
    spectatorJoinToken,
    spectatorObserverTicket,
    tabId,
    call
  ]);

  useEffect(() => {
    if (!canConnect || call || busy || error) {
      return;
    }
    const autoJoinKey = `${meetingId ?? "no-meeting"}:${streamCallType ?? "no-type"}:${streamCallId ?? "no-call"}:${spectatorJoinToken ?? ""}:${spectatorObserverTicket ?? ""}`;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, canConnect, error, meetingId, spectatorJoinToken, spectatorObserverTicket, startStream, streamCallId, streamCallType]);

  useEffect(() => {
    if (canConnect) {
      return;
    }
    void disconnectStream();
    noParticipantsReconnectDoneRef.current = null;
  }, [canConnect, disconnectStream]);

  useEffect(() => {
    if (!canConnect || !call || hasParticipants !== false || busy) {
      return;
    }
    const reconnectKey = `${meetingId ?? "no-meeting"}:${streamCallType ?? "no-type"}:${streamCallId ?? "no-call"}`;
    if (noParticipantsReconnectDoneRef.current === reconnectKey) {
      return;
    }
    const timer = setTimeout(() => {
      if (noParticipantsReconnectDoneRef.current === reconnectKey) {
        return;
      }
      noParticipantsReconnectDoneRef.current = reconnectKey;
      void disconnectStream().then(() => {
        // Allow one auto-rejoin attempt when call presence lags behind join.
        autoJoinAttemptForRef.current = null;
      });
    }, OBSERVER_NO_PARTICIPANTS_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    busy,
    call,
    canConnect,
    disconnectStream,
    hasParticipants,
    meetingId,
    streamCallId,
    streamCallType
  ]);

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
      cleanupSelfPreview();
    },
    [cleanupSelfPreview, disconnectStream]
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
        <div className={cn("relative h-full w-full", ended && "opacity-80")}>
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <ObserverCallBody
                  localUserId={localUserId}
                  onParticipantsDetected={setHasParticipants}
                  sessionMirrorLayout={sessionMirrorLayout}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
          {showSelfPreview ? (
            <div className="pointer-events-none absolute right-3 top-3 z-20 w-44 rounded-xl border border-white/40 bg-slate-900/75 p-2 shadow-lg backdrop-blur">
              <div className="overflow-hidden rounded-lg bg-black">
                {selfPreviewStream && selfCameraEnabled ? (
                  <video ref={selfPreviewVideoRef} className="h-24 w-full object-cover" muted playsInline autoPlay />
                ) : (
                  <div className="flex h-24 w-full items-center justify-center text-xs text-slate-300">
                    Камера выключена
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant={selfCameraEnabled ? "default" : "secondary"}
                  className="pointer-events-auto h-9 rounded-full px-3 text-xs"
                  disabled={!selfPreviewStream}
                  onClick={() => setSelfCameraEnabled((prev) => !prev)}
                  title={selfCameraEnabled ? "Выключить камеру" : "Включить камеру"}
                >
                  {selfCameraEnabled ? <Video className="mr-1 h-3.5 w-3.5" /> : <VideoOff className="mr-1 h-3.5 w-3.5" />}
                  {selfCameraEnabled ? "Камера: вкл" : "Камера: выкл"}
                </Button>
                <Button
                  type="button"
                  variant={selfMicEnabled ? "default" : "secondary"}
                  className="pointer-events-auto h-9 rounded-full px-3 text-xs"
                  disabled={!selfPreviewStream}
                  onClick={() => setSelfMicEnabled((prev) => !prev)}
                  title={selfMicEnabled ? "Выключить микрофон" : "Включить микрофон"}
                >
                  {selfMicEnabled ? <Mic className="mr-1 h-3.5 w-3.5" /> : <MicOff className="mr-1 h-3.5 w-3.5" />}
                  {selfMicEnabled ? "Микрофон: вкл" : "Микрофон: выкл"}
                </Button>
                {selfPreviewError ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="pointer-events-auto h-8 rounded-full px-3 text-[11px]"
                    onClick={() => void ensureSelfPreview()}
                  >
                    Повторить доступ
                  </Button>
                ) : null}
              </div>
              {selfPreviewError ? (
                <p className="mt-2 rounded-lg bg-rose-100/90 px-2 py-1 text-[11px] leading-snug text-rose-700">
                  {selfPreviewError}
                </p>
              ) : null}
            </div>
          ) : null}
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
