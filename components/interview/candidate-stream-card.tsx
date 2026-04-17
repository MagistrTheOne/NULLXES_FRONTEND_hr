"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import type { InterviewStartContext, InterviewStartResult } from "@/hooks/use-interview-session";
import { Button } from "@/components/ui/button";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";

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
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Stream is not connected</div>;
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
  showControls = true
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
  }, [getParticipantId, interviewContext, interviewId, meetingAt, meetingId, onEnsureInterviewStart, participantName, sessionId]);

  useEffect(() => {
    if (!enabled || !meetingId || !sessionId || call || busy) {
      return;
    }
    const autoJoinKey = `${meetingId}:${sessionId}`;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, enabled, meetingId, sessionId, startStream]);

  useEffect(() => {
    if (!autoConnectOnEntry || autoEntryAttemptRef.current || call || busy) {
      return;
    }
    autoEntryAttemptRef.current = true;
    void startStream();
  }, [autoConnectOnEntry, busy, call, startStream]);

  useEffect(() => {
    if (enabled && meetingId && sessionId) {
      return;
    }
    void disconnectStream();
  }, [disconnectStream, enabled, meetingId, sessionId]);

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
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm leading-snug">{participantName}</p>
          </div>

          {!call && showControls ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="rounded-full px-3" onClick={startStream} disabled={busy}>
                Подключиться
              </Button>
            </div>
          ) : null}
        </>
      }
      error={error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
    >
      {client && call ? (
        <div className="h-full w-full">
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <CandidateCallBody
                  showControls={showControls}
                  meetingId={callRoomId}
                  onLeave={handleLeaveFromControls}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          {showControls ? "Нажмите «Подключиться» для входа" : "Ожидание старта собеседования"}
        </div>
      )}
    </StreamParticipantShell>
  );
}
