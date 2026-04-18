"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CallControls, CallingState, ParticipantView, StreamCall, StreamTheme, StreamVideo, StreamVideoClient, useCallStateHooks } from "@stream-io/video-react-sdk";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { Badge } from "@/components/ui/badge";

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

type AvatarCallBodyProps = {
  /** Stream SDK toolbar (mic/camera/layout/video mode). Off for HR avatar by default. */
  showStreamToolbar: boolean;
  meetingId: string;
  onLeave?: (err?: Error) => void | Promise<void>;
};

function AvatarCallBody({ showStreamToolbar, meetingId, onLeave }: AvatarCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();
  const avatarParticipant =
    participants.find((participant) => participant.userId === `agent-${meetingId}`) ?? participants[0] ?? null;
  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Ожидание подключения аватара...</div>;
  }
  return (
    <div className="stream-call-ui h-full w-full">
      <div className="stream-call-layout">
        {avatarParticipant ? (
          <ParticipantView participant={avatarParticipant} trackType="videoTrack" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Ожидание HR-аватара</div>
        )}
      </div>
      {showStreamToolbar ? (
        <div className="stream-call-controls">
          <CallControls onLeave={onLeave} />
        </div>
      ) : null}
    </div>
  );
}

type AvatarStreamCardProps = {
  participantName: string;
  enabled: boolean;
  avatarReady: boolean;
  meetingId: string | null;
  /** Show mic/camera/layout controls from Stream (often includes «video mode»). Default off for HR. */
  showStreamToolbar?: boolean;
  /** Status badge under the card title */
  showStatusBadge?: boolean;
  /** Остановить AI-сессию (звонок + бот) — см. useInterviewSession.stop */
  showStopAI?: boolean;
  onStopAI?: () => void;
  stopAIDisabled?: boolean;
};

export function AvatarStreamCard({
  participantName,
  enabled,
  avatarReady,
  meetingId,
  showStreamToolbar = false,
  showStatusBadge = true,
  showStopAI = false,
  onStopAI,
  stopAIDisabled = false,
}: AvatarStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const canRenderAvatarWindow = enabled && Boolean(client && call);
  const [busy, setBusy] = useState(false);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const callRoomId = meetingId ?? "unknown-meeting";

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
    setCall(null);
    setClient(null);
    autoJoinAttemptForRef.current = null;
  }, [call, client]);

  const startStream = useCallback(async () => {
    if (!meetingId) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/stream/token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "admin",
          meetingId,
          userId: `agent-${meetingId}`,
          userName: participantName
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "Failed to issue HR stream token");
      }

      const payload = (await response.json()) as StreamTokenResponse;
      const streamClient = new StreamVideoClient({
        apiKey: payload.apiKey,
        token: payload.token,
        user: payload.user
      });
      const streamCall = streamClient.call(payload.callType, payload.callId);
      await streamCall.join({ create: true, video: false });

      setClient(streamClient);
      setCall(streamCall);
    } catch {
      autoJoinAttemptForRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [meetingId, participantName]);

  useEffect(() => {
    if (!enabled || !meetingId || call || busy) {
      return;
    }
    const autoJoinKey = meetingId;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, enabled, meetingId, startStream]);

  useEffect(() => {
    if (enabled && meetingId) {
      return;
    }
    void disconnectStream();
  }, [disconnectStream, enabled, meetingId]);

  const handleLeaveFromControls = useCallback(
    async (err?: Error) => {
      if (err) {
        return;
      }
      await disconnectStream();
    },
    [disconnectStream]
  );

  return (
    <StreamParticipantShell
      title="HR аватар"
      videoRef={streamViewportRef}
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm leading-snug">{participantName}</p>
            {showStatusBadge ? (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="shrink-0 rounded-full px-2.5">
                  {canRenderAvatarWindow ? "Connected" : avatarReady ? "Ready" : "Idle"}
                </Badge>
              </div>
            ) : null}
          </div>
          {showStopAI && onStopAI ? (
            <button
              type="button"
              disabled={stopAIDisabled}
              onClick={onStopAI}
              className="w-full rounded-xl border border-rose-300/80 bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Стоп
            </button>
          ) : null}
        </>
      }
    >
      {canRenderAvatarWindow && client && call ? (
        <div className="h-full w-full">
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <AvatarCallBody
                  showStreamToolbar={showStreamToolbar}
                  meetingId={callRoomId}
                  onLeave={handleLeaveFromControls}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">Загрузка</div>
      )}
    </StreamParticipantShell>
  );
}
