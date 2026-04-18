"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CallControls,
  CallingState,
  ParticipantView,
  StreamCall,
  StreamTheme,
  StreamVideo,
  StreamVideoClient,
  useCallStateHooks
} from "@stream-io/video-react-sdk";
import { releaseCandidateAdmission, sendRealtimeEvent } from "@/lib/api";
import { formatCandidateMeetingLobbyMessage, isMeetingNotYetOpen } from "@/lib/meeting-at-guard";
import type { InterviewStartContext, InterviewStartResult } from "@/hooks/use-interview-session";
import type { SessionUIState } from "@/lib/session-ui-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { cn } from "@/lib/utils";
import { VideoOff } from "lucide-react";

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
  showControls: boolean;
  meetingId: string;
  onLeave?: (err?: Error) => void | Promise<void>;
};

function CandidateCallBody({ showControls, meetingId, onLeave }: CandidateCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();
  const candidateParticipant =
    participants.find((participant) => participant.userId === `candidate-${meetingId}`) ?? participants[0] ?? null;

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Поток не подключён</div>;
  }

  return (
    <div className="stream-call-ui h-full w-full">
      <div className="stream-call-layout">
        {candidateParticipant ? (
          <ParticipantView participant={candidateParticipant} trackType="videoTrack" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Ожидание кандидата</div>
        )}
      </div>
      {showControls ? (
        <div className="stream-call-controls">
          <CallControls onLeave={onLeave} />
        </div>
      ) : null}
    </div>
  );
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
};

export function CandidateStreamCard({
  meetingId,
  sessionId,
  enabled = true,
  autoConnectOnEntry = false,
  participantName,
  interviewId,
  meetingAt,
  onEnsureInterviewStart,
  interviewContext,
  showControls = true,
  sessionEnded = false,
  uiState
}: CandidateStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const autoEntryAttemptRef = useRef<boolean>(false);
  const participantIdRef = useRef<string | null>(null);
  const callRoomId = meetingId ?? "unknown-meeting";

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const interactiveDisabled = ended;

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
    if (isMeetingNotYetOpen(meetingAt)) {
      setError(formatCandidateMeetingLobbyMessage(meetingAt!.trim()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let effectiveMeetingId = meetingId;
      let effectiveSessionId = sessionId;

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
      const streamClient = new StreamVideoClient({
        apiKey: payload.apiKey,
        token: payload.token,
        user: payload.user
      });
      const streamCall = streamClient.call(payload.callType, payload.callId);
      await streamCall.camera.disable().catch(() => undefined);
      await streamCall.join({ create: true, video: false });
      await streamCall.camera.disable().catch(() => undefined);

      setClient(streamClient);
      setCall(streamCall);

      if (effectiveSessionId) {
        await sendRealtimeEvent(effectiveSessionId, {
          type: "candidate.stream.joined",
          meetingId: effectiveMeetingId,
          streamCallId: payload.callId
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start candidate stream");
      autoJoinAttemptForRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [ended, getParticipantId, interviewContext, interviewId, meetingAt, meetingId, onEnsureInterviewStart, participantName, sessionId]);

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
    if (isMeetingNotYetOpen(meetingAt)) {
      return;
    }
    const autoJoinKey = meetingId;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, enabled, ended, meetingAt, meetingId, startStream]);

  useEffect(() => {
    if (!autoConnectOnEntry || ended || autoEntryAttemptRef.current || call || busy) {
      return;
    }
    if (isMeetingNotYetOpen(meetingAt)) {
      return;
    }
    autoEntryAttemptRef.current = true;
    void startStream();
  }, [autoConnectOnEntry, busy, call, ended, meetingAt, startStream]);

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
      error={error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
    >
      {client && call ? (
        <div className={cn("h-full w-full", interactiveDisabled && "pointer-events-none opacity-70")}>
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <CandidateCallBody
                  showControls={showControls && !interactiveDisabled}
                  meetingId={callRoomId}
                  onLeave={handleLeaveFromControls}
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
              <p className="max-w-[260px] text-sm text-slate-600">
                {autoConnectOnEntry
                  ? "Подключение к потоку выполнится автоматически после старта сессии HR."
                  : showControls
                    ? "Нажмите «Подключиться», чтобы начать"
                    : "Ожидание старта собеседования"}
              </p>
            </>
          )}
        </div>
      )}
    </StreamParticipantShell>
  );
}
