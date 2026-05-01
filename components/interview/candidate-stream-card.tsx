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
import { releaseCandidateAdmission, sendRealtimeEvent, startMeetingRecording } from "@/lib/api";
import { isRecordingUiEnabled } from "@/lib/feature-flags";
import { formatCandidateMeetingLobbyMessage, isMeetingNotYetOpen } from "@/lib/meeting-at-guard";
import type { InterviewStartContext, InterviewStartResult } from "@/hooks/use-interview-session";
import type { SessionUIState } from "@/lib/session-ui-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { ConnectionQualityBadge } from "@/components/interview/connection-quality-badge";
import { useConnectionQuality, type ConnectionQualityReading } from "@/hooks/use-connection-quality";
import { cn } from "@/lib/utils";
import { VideoOff } from "lucide-react";
import { acquireLocalMediaPreviewStream } from "@/lib/webrtc-client";

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

type CandidateCallBodyProps = {
  call: ReturnType<StreamVideoClient["call"]>;
  showControls: boolean;
  meetingId: string;
  initialCameraEnabled?: boolean;
  initialMicEnabled?: boolean;
  onLeave?: (err?: Error) => void | Promise<void>;
  /** Bubble live connection quality up to the shell for banner / toast. */
  onQualityChange?: (reading: ConnectionQualityReading) => void;
  /** Report whether an observer participant is present in the call. */
  onObserverPresenceChange?: (present: boolean) => void;
};

function CandidateCallBody({
  call: _call,
  showControls,
  meetingId: _meetingId,
  initialCameraEnabled: _initialCameraEnabled = false,
  initialMicEnabled: _initialMicEnabled = false,
  onLeave,
  onQualityChange,
  onObserverPresenceChange
}: CandidateCallBodyProps) {
  void _call;
  void _meetingId;
  void _initialCameraEnabled;
  void _initialMicEnabled;
  const {
    useCallCallingState,
    useLocalParticipant,
    useCameraState,
    useMicrophoneState,
    useParticipants
  } = useCallStateHooks();
  const state = useCallCallingState();
  const localParticipant = useLocalParticipant();
  const participants = useParticipants();
  const { camera, optionsAwareIsMute: cameraPublishMuted, isTogglePending: cameraTogglePending } = useCameraState({
    optimisticUpdates: true
  });
  const { microphone, optionsAwareIsMute: micPublishMuted, isTogglePending: micTogglePending } = useMicrophoneState({
    optimisticUpdates: true
  });
  const cameraEnabled = !cameraPublishMuted;
  const micEnabled = !micPublishMuted;
  const quality = useConnectionQuality();

  // Push quality readings up to the shell so banner / toast can react. Wrap
  // in useEffect so we never trigger a parent re-render mid-render of this
  // component.
  useEffect(() => {
    onQualityChange?.(quality);
  }, [onQualityChange, quality]);

  const observerPresent = useMemo(() => {
    if (!participants?.length) return false;
    return participants.some((p) => {
      const id = participantStreamUserId(p);
      return id.startsWith("observer-") || id.startsWith("observer-dashboard-");
    });
  }, [participants]);

  useEffect(() => {
    onObserverPresenceChange?.(observerPresent);
  }, [observerPresent, onObserverPresenceChange]);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [micBusy, setMicBusy] = useState(false);

  const runTrackAction = useCallback(
    async (toggle: () => Promise<void>) => {
      try {
        await toggle();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await toggle();
      }
    },
    []
  );

  const handleCameraToggle = useCallback(async () => {
    if (cameraBusy || cameraTogglePending) {
      return;
    }
    setCameraBusy(true);
    try {
      if (cameraEnabled) {
        await runTrackAction(() => camera.disable());
      } else {
        await runTrackAction(() => camera.enable());
      }
    } finally {
      setCameraBusy(false);
    }
  }, [camera, cameraBusy, cameraEnabled, cameraTogglePending, runTrackAction]);

  const handleMicToggle = useCallback(async () => {
    if (micBusy || micTogglePending) {
      return;
    }
    setMicBusy(true);
    try {
      if (micEnabled) {
        await runTrackAction(() => microphone.disable());
      } else {
        await runTrackAction(() => microphone.enable());
      }
    } finally {
      setMicBusy(false);
    }
  }, [micBusy, micEnabled, micTogglePending, microphone, runTrackAction]);

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Поток не подключён</div>;
  }

  const showBadge = state === CallingState.JOINED;

  return (
    <div className="stream-call-ui h-full w-full">
      <div className="stream-call-layout relative">
        {localParticipant ? (
          <ParticipantView
            participant={localParticipant}
            trackType="videoTrack"
            // Default Stream chrome reads SFU track flags and often disagrees with
            // publishing toggles for a beat; we already show камера/микрофон below.
            ParticipantViewUI={() => null}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Ожидание кандидата</div>
        )}
        {participants ? (
          (() => {
            const observer =
              participants.find((p) => {
                const id = participantStreamUserId(p);
                return id.startsWith("observer-") || id.startsWith("observer-dashboard-");
              }) ?? null;
            if (!observer) return null;
            return (
              <div className="absolute bottom-3 right-3 z-20 h-28 w-28 overflow-hidden rounded-xl border border-white/60 bg-black shadow-lg">
                <ParticipantView participant={observer} trackType="videoTrack" ParticipantViewUI={() => null} />
              </div>
            );
          })()
        ) : null}
        {showBadge ? (
          <ConnectionQualityBadge
            reading={quality}
            className="absolute right-2 top-2 z-10"
          />
        ) : null}
      </div>
      {showControls ? (
        <div className="stream-call-controls flex flex-wrap items-center justify-center gap-2 p-2">
          <Button
            type="button"
            variant={cameraEnabled ? "default" : "secondary"}
            className="h-9 rounded-full px-4 text-xs"
            disabled={cameraBusy || cameraTogglePending}
            onClick={() => void handleCameraToggle()}
            title={cameraEnabled ? "Выключить камеру" : "Включить камеру"}
          >
            {cameraBusy || cameraTogglePending ? "Камера..." : cameraEnabled ? "Камера: вкл" : "Камера: выкл"}
          </Button>
          <Button
            type="button"
            variant={micEnabled ? "default" : "secondary"}
            className="h-9 rounded-full px-4 text-xs"
            disabled={micBusy || micTogglePending}
            onClick={() => void handleMicToggle()}
            title={micEnabled ? "Выключить микрофон" : "Включить микрофон"}
          >
            {micBusy || micTogglePending ? "Микрофон..." : micEnabled ? "Микрофон: вкл" : "Микрофон: выкл"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-9 rounded-full px-4 text-xs"
            onClick={() => void onLeave?.()}
          >
            Выйти из звонка
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function participantStreamUserId(p: { userId?: string; user?: { id?: string } }): string {
  if (typeof p.userId === "string" && p.userId.length > 0) {
    return p.userId;
  }
  const id = p.user && typeof p.user.id === "string" ? p.user.id : "";
  return id;
}

/**
 * HR dashboard joins Stream as a local `candidate-*` placeholder; real candidate
 * presence is a **remote** `candidate-*`. Candidate-flow uses the local candidate id.
 */
function InterviewCandidatePresenceReporter({
  isCandidateFlow,
  onChange
}: {
  isCandidateFlow: boolean;
  onChange: (present: boolean) => void;
}) {
  const { useParticipants, useCallCallingState } = useCallStateHooks();
  const participants = useParticipants();
  const callingState = useCallCallingState();

  const present =
    callingState === CallingState.JOINED &&
    (participants.some(
      (p) => !p.isLocalParticipant && participantStreamUserId(p).startsWith("candidate-")
    ) ||
      (isCandidateFlow &&
        participants.some(
          (p) => p.isLocalParticipant && participantStreamUserId(p).startsWith("candidate-")
        )));

  useEffect(() => {
    onChange(present);
  }, [onChange, present]);

  useEffect(
    () => () => {
      onChange(false);
    },
    [onChange]
  );

  return null;
}

type CandidateStreamCardProps = {
  meetingId: string | null;
  sessionId: string | null;
  enabled?: boolean;
  autoConnectOnEntry?: boolean;
  participantName: string;
  interviewId?: number;
  meetingAt?: string;
  onEnsureInterviewStart: (options?: {
    triggerSource?: string;
    interviewId?: number;
    meetingAt?: string;
    bypassMeetingAtGuard?: boolean;
    interviewContext?: InterviewStartContext;
  }) => Promise<InterviewStartResult>;
  interviewContext?: InterviewStartContext;
  showControls?: boolean;
  /** Сессия в статусе completed на gateway/JobAI — блок подключения и кнопки. */
  sessionEnded?: boolean;
  /** Единый режим UI с interview-shell (дублирует sessionEnded при `completed`). */
  uiState?: SessionUIState;
  /** Bubble live connection quality up to the shell (banner + toast hooks). */
  onQualityChange?: (reading: ConnectionQualityReading) => void;
  /** Candidate entry URL flow (`?entry=candidate`) — local Stream user counts as interview candidate. */
  isCandidateFlow?: boolean;
  /**
   * Fires when a **real** remote candidate joins the Stream room (HR) or when
   * the candidate-flow user is joined as `candidate-*` (self).
   */
  onInterviewCandidatePresenceChange?: (present: boolean) => void;
  /** HR shell: observer column should be shown only when observer is present in the call. */
  onObserverPresenceChange?: (present: boolean) => void;
  /**
   * Кандидат: сначала одна кнопка проверки камеры+микрофона (вкл/выкл превью),
   * затем ручное «Подключиться» к Stream; авто-join видео отключён.
   */
  requireMediaCheckBeforeConnect?: boolean;
};

export function CandidateStreamCard({
  meetingId,
  sessionId,
  enabled = true,
  autoConnectOnEntry = false,
  requireMediaCheckBeforeConnect = false,
  participantName,
  interviewId,
  meetingAt,
  onEnsureInterviewStart,
  interviewContext,
  showControls = true,
  sessionEnded = false,
  uiState,
  onQualityChange,
  isCandidateFlow = false,
  onInterviewCandidatePresenceChange,
  onObserverPresenceChange
}: CandidateStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [mediaCheckBusy, setMediaCheckBusy] = useState(false);
  const [mediaCheckPassedOnce, setMediaCheckPassedOnce] = useState(false);
  const [mediaCheckWarning, setMediaCheckWarning] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  // Фильтр: какие ошибки мы НЕ показываем кандидату красной плашкой.
  // Технические транспорт-ошибки (timeout / network / stream-io) ничего
  // полезного кандидату не сообщают, а только пугают его посреди интервью.
  // Retry-логика live-рефреша токена и реконнект Stream разруливают
  // это сами; если что-то действительно фатально — сессия всё равно
  // переведётся в «завершено» по сигналу из хука. Оставляем только
  // бизнес-сообщения (лобби/ожидание HR/отказ одобрения и т.п.).
  const isTransientTransportError = useCallback((message: string): boolean => {
    const lower = message.toLowerCase();
    return (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("failed to fetch") ||
      lower.includes("network") ||
      lower.includes("aborterror") ||
      lower.includes("abort") ||
      lower.includes("failed to start candidate stream") ||
      lower.includes("failed to issue stream token") ||
      lower.includes("stream-io") ||
      lower.includes("websocket")
    );
  }, []);
  const visibleError = error && !isTransientTransportError(error) ? error : null;
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const autoEntryAttemptRef = useRef<boolean>(false);
  const participantIdRef = useRef<string | null>(null);
  const callRoomId = meetingId ?? "unknown-meeting";

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const interactiveDisabled = ended;
  const mediaCheckActive = Boolean(previewStream);

  const statusBadgeLabel = useMemo(() => {
    if (ended) {
      return "Завершено";
    }
    if (call) {
      return "В эфире";
    }
    if (!enabled) {
      return "Ожидаем запуск";
    }
    if (busy) {
      return "Подключаемся…";
    }
    return "Не в эфире";
  }, [busy, call, enabled, ended]);

  const getParticipantId = useCallback(() => {
    if (participantIdRef.current) {
      return participantIdRef.current;
    }
    if (typeof window === "undefined") {
      const generated = `candidate-${Math.random().toString(36).slice(2, 12)}`;
      participantIdRef.current = generated;
      return generated;
    }
    const storageKey = interviewId ? `nullxes:candidate-participant:${interviewId}` : "nullxes:candidate-participant";
    const existing = window.localStorage.getItem(storageKey)?.trim();
    if (existing) {
      participantIdRef.current = existing;
      return existing;
    }
    const generated = `candidate-${crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, generated);
    participantIdRef.current = generated;
    return generated;
  }, [interviewId]);

  useEffect(() => {
    const el = previewVideoRef.current;
    if (!el || !previewStream) {
      return;
    }
    el.srcObject = previewStream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [previewStream]);

  useEffect(() => {
    return () => {
      setPreviewStream((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return null;
      });
    };
  }, []);

  useEffect(() => {
    if (ended) {
      setPreviewStream((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return null;
      });
    }
  }, [ended]);

  const stopMediaPreview = useCallback(() => {
    setPreviewStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }, []);

  const toggleMediaDevicesCheck = useCallback(async () => {
    if (mediaCheckBusy) {
      return;
    }
    if (previewStream) {
      stopMediaPreview();
      return;
    }
    setMediaCheckBusy(true);
    setError(null);
    setMediaCheckWarning(null);
    try {
      const result = await acquireLocalMediaPreviewStream();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMediaCheckPassedOnce(true);
      setPreviewStream(result.stream);
      if (result.warning) {
        setMediaCheckWarning(result.warning);
      }
    } finally {
      setMediaCheckBusy(false);
    }
  }, [mediaCheckBusy, previewStream, stopMediaPreview]);

  useEffect(() => {
    const root = streamViewportRef.current;
    if (!root) {
      return;
    }
    const muteMedia = () => {
      root.querySelectorAll("audio, video").forEach((element) => {
        const media = element as HTMLMediaElement;
        media.muted = true;
        media.volume = 0;
      });
    };
    muteMedia();
    const observer = new MutationObserver(() => muteMedia());
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [call]);

  const disconnectStream = useCallback(async () => {
    if (call) {
      await call.leave().catch(() => undefined);
    }
    if (client) {
      await client.disconnectUser().catch(() => undefined);
    }
    if (meetingId && participantIdRef.current) {
      await releaseCandidateAdmission(meetingId, {
        participantId: participantIdRef.current,
        reason: "candidate_disconnect"
      }).catch(() => undefined);
    }
    setCall(null);
    setClient(null);
    autoJoinAttemptForRef.current = null;
  }, [call, client, meetingId]);

  const startStream = useCallback(async () => {
    if (ended) {
      return;
    }
    if (requireMediaCheckBeforeConnect && !mediaCheckPassedOnce) {
      setError("Сначала нажмите «Проверить камеру и микрофон» и убедитесь, что превью открывается.");
      return;
    }
    if (isMeetingNotYetOpen(meetingAt)) {
      setError(formatCandidateMeetingLobbyMessage(meetingAt!.trim()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let effectiveMeetingId = meetingId;
      let effectiveSessionId = sessionId;
      if (requireMediaCheckBeforeConnect) {
        stopMediaPreview();
      }

      if (!effectiveMeetingId || !effectiveSessionId) {
        const started = await onEnsureInterviewStart({
          triggerSource: "join_stream",
          interviewId,
          meetingAt,
          interviewContext
        });
        effectiveMeetingId = started.meetingId;
        effectiveSessionId = started.sessionId;
      }

      const response = await fetch("/api/stream/token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "candidate",
          meetingId: effectiveMeetingId,
          userName: participantName,
          participantId: getParticipantId()
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
        if (response.status === 423 || payload.code === "admission.awaiting_approval") {
          throw new Error("Вход ожидает подтверждения HR. Попросите HR одобрить подключение кандидата.");
        }
        throw new Error(payload.message ?? "Failed to issue Stream token");
      }

      const payload = (await response.json()) as StreamTokenResponse;
      // Переопределяем дефолтный axios-timeout SDK (5000мс) на 60_000мс —
      // см. комментарий в avatar-stream-card про источник «timeout of
      // 5000ms exceeded». 5с недостаточно для coordinator round-trip на
      // плохой сети и ломает сессию кандидата посреди интервью.
      const streamClient = new StreamVideoClient({
        apiKey: payload.apiKey,
        token: payload.token,
        user: payload.user,
        options: { timeout: 60_000 }
      });
      const streamCall = streamClient.call(payload.callType, payload.callId);
      const publishLocalMedia = requireMediaCheckBeforeConnect;
      if (!publishLocalMedia) {
        await streamCall.camera.disable().catch(() => undefined);
        await streamCall.microphone.disable().catch(() => undefined);
      }
      await streamCall.join({ create: true, video: publishLocalMedia });
      if (publishLocalMedia) {
        await streamCall.camera.enable().catch(() => undefined);
        await streamCall.microphone.enable().catch(() => undefined);
      } else {
        await streamCall.camera.disable().catch(() => undefined);
        await streamCall.microphone.disable().catch(() => undefined);
      }

      setClient(streamClient);
      setCall(streamCall);
      stopMediaPreview();

      if (isRecordingUiEnabled()) {
        await startMeetingRecording(effectiveMeetingId, {
          callId: payload.callId,
          callType: payload.callType
        }).catch((recordingError) => {
          void recordingError;
        });
      }

      if (effectiveSessionId) {
        await sendRealtimeEvent(effectiveSessionId, {
          type: "candidate.stream.joined",
          meetingId: effectiveMeetingId,
          streamCallId: payload.callId
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start candidate stream";
      void err;
      setError(message);
      autoJoinAttemptForRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [
    ended,
    getParticipantId,
    interviewContext,
    interviewId,
    meetingAt,
    meetingId,
    mediaCheckPassedOnce,
    onEnsureInterviewStart,
    participantName,
    requireMediaCheckBeforeConnect,
    sessionId,
    stopMediaPreview
  ]);

  useEffect(() => {
    if (ended) {
      void disconnectStream();
    }
  }, [disconnectStream, ended]);

  useEffect(() => {
    // Match HR avatar card: join Stream as soon as meeting exists + session is connected.
    // Do not require `sessionId` here — it can lag behind hook state and would block auto-join forever.
    if (!enabled || ended || !meetingId || call || busy) {
      return;
    }
    if (requireMediaCheckBeforeConnect && !mediaCheckPassedOnce) {
      return;
    }
    if (isMeetingNotYetOpen(meetingAt)) {
      return;
    }
    const autoJoinKey = meetingId;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, enabled, ended, mediaCheckPassedOnce, meetingAt, meetingId, requireMediaCheckBeforeConnect, startStream]);

  useEffect(() => {
    if (!autoConnectOnEntry || ended || autoEntryAttemptRef.current || call || busy) {
      return;
    }
    if (requireMediaCheckBeforeConnect && !mediaCheckPassedOnce) {
      return;
    }
    if (isMeetingNotYetOpen(meetingAt)) {
      return;
    }
    autoEntryAttemptRef.current = true;
    void startStream();
  }, [autoConnectOnEntry, busy, call, ended, mediaCheckPassedOnce, meetingAt, requireMediaCheckBeforeConnect, startStream]);

  useEffect(() => {
    if (enabled && meetingId) {
      return;
    }
    void disconnectStream();
  }, [disconnectStream, enabled, meetingId]);

  const handleLeaveFromControls = useCallback(
    async (err?: Error) => {
      if (err) {
        setError(err.message);
        return;
      }
      await disconnectStream();
      if (sessionId) {
        await sendRealtimeEvent(sessionId, {
          type: "candidate.stream.left",
          meetingId: callRoomId
        }).catch(() => undefined);
      }
    },
    [callRoomId, disconnectStream, sessionId]
  );

  return (
    <StreamParticipantShell
      title="Кандидат"
      videoRef={streamViewportRef}
      videoClassName={cn(!client || !call ? "bg-slate-300/70" : undefined, interactiveDisabled && "pointer-events-none")}
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{participantName}</p>
            <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
              <span className="mr-1 text-emerald-600" aria-hidden>
                ●
              </span>
              {statusBadgeLabel}
            </Badge>
          </div>

          <div className="flex min-h-10 flex-wrap gap-2">
            {ended ? (
              <p className="w-full text-xs leading-relaxed text-slate-600">
                Сессия завершена.
                <span className="mt-0.5 block">Повторное подключение недоступно.</span>
              </p>
            ) : !call && showControls && requireMediaCheckBeforeConnect ? (
              <>
                <Button
                  type="button"
                  variant={mediaCheckActive ? "secondary" : "default"}
                  className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  disabled={mediaCheckBusy || interactiveDisabled}
                  onClick={() => void toggleMediaDevicesCheck()}
                  title={
                    mediaCheckActive
                      ? "Остановить проверку и выключить камеру/микрофон"
                      : "Включить камеру и микрофон для проверки"
                  }
                >
                  {mediaCheckBusy
                    ? "Проверка…"
                    : mediaCheckActive
                      ? "Остановить проверку"
                      : "Проверить камеру и микрофон"}
                </Button>
                <Button
                  type="button"
                  className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  onClick={() => void startStream()}
                  disabled={
                    busy ||
                    interactiveDisabled ||
                    isMeetingNotYetOpen(meetingAt) ||
                    !mediaCheckPassedOnce
                  }
                  title={
                    !mediaCheckPassedOnce
                      ? "Сначала выполните проверку устройств"
                      : isMeetingNotYetOpen(meetingAt) && meetingAt?.trim()
                          ? formatCandidateMeetingLobbyMessage(meetingAt.trim())
                          : "Подключиться к видеопотоку собеседования"
                  }
                >
                  Подключиться к видео
                </Button>
              </>
            ) : !call && showControls && !autoConnectOnEntry ? (
              <Button
                type="button"
                className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                onClick={() => void startStream()}
                disabled={busy || interactiveDisabled || isMeetingNotYetOpen(meetingAt)}
                title={
                  isMeetingNotYetOpen(meetingAt) && meetingAt?.trim()
                    ? formatCandidateMeetingLobbyMessage(meetingAt.trim())
                    : undefined
                }
              >
                Подключиться
              </Button>
            ) : null}
          </div>
        </>
      }
      error={visibleError ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{visibleError}</p> : null}
    >
      {client && call ? (
        <div className={cn("h-full w-full", interactiveDisabled && "pointer-events-none opacity-70")}>
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                {onInterviewCandidatePresenceChange ? (
                  <InterviewCandidatePresenceReporter
                    isCandidateFlow={isCandidateFlow}
                    onChange={onInterviewCandidatePresenceChange}
                  />
                ) : null}
                <CandidateCallBody
                  call={call}
                  showControls={showControls && !interactiveDisabled}
                  meetingId={callRoomId}
                  initialCameraEnabled={requireMediaCheckBeforeConnect}
                  initialMicEnabled={requireMediaCheckBeforeConnect}
                  onLeave={handleLeaveFromControls}
                  onQualityChange={onQualityChange}
                  onObserverPresenceChange={onObserverPresenceChange}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <VideoOff className="h-8 w-8 shrink-0 text-slate-600" strokeWidth={1.75} aria-hidden />
          {ended ? (
            <>
              <p className="text-sm font-medium text-slate-700">Сессия завершена</p>
              <p className="max-w-[240px] text-xs text-slate-600">Повторное подключение недоступно</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-700">Видео не подключено</p>
              {requireMediaCheckBeforeConnect ? (
                <div className="mt-1 w-full max-w-[560px]">
                  <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-950 shadow-sm">
                    {previewStream ? (
                      <video
                        ref={previewVideoRef}
                        className="absolute inset-0 h-full w-full object-cover"
                        playsInline
                        muted
                        autoPlay
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] leading-snug text-slate-200/90">
                        <span className="block max-w-[260px] wrap-break-word">
                          Нажмите «Проверить камеру и микрофон», чтобы увидеть превью
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              <p className="max-w-[280px] text-sm text-slate-600">
                {requireMediaCheckBeforeConnect
                  ? "Шаг 1: проверьте камеру и микрофон одной кнопкой внизу. Шаг 2: когда сессия активна — «Подключиться к видео»."
                  : autoConnectOnEntry
                    ? "Подключение к потоку выполнится автоматически после старта сессии HR."
                    : showControls
                      ? "Нажмите «Подключиться», чтобы начать"
                      : "Ожидание старта собеседования"}
              </p>
              {mediaCheckWarning ? (
                <p className="max-w-[320px] rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{mediaCheckWarning}</p>
              ) : null}
            </>
          )}
        </div>
      )}
    </StreamParticipantShell>
  );
}
