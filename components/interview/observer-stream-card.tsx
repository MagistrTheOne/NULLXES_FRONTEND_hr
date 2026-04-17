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
import { Badge } from "@/components/ui/badge";
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

type ObserverTalkMode = "off" | "on";
export type ObserverConnectionStatus =
  | "waiting_meeting"
  | "joining"
  | "joined"
  | "no_participants"
  | "error"
  | "idle_hidden";

type ObserverCallBodyProps = {
  localUserId: string;
  onParticipantsDetected?: (hasParticipants: boolean) => void;
};

function ObserverCallBody({ localUserId, onParticipantsDetected }: ObserverCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  const orderedParticipants = useMemo(() => {
    const observer = participants.find((participant) => participant.userId === localUserId) ?? null;
    const candidate = participants.find((participant) => participant.userId?.startsWith("candidate-")) ?? null;
    const agent = participants.find((participant) => participant.userId?.startsWith("agent-")) ?? null;
    const byId = new Set<string>();
    const ordered: typeof participants = [];
    for (const participant of [observer, candidate, agent]) {
      if (!participant?.sessionId || byId.has(participant.sessionId)) {
        continue;
      }
      byId.add(participant.sessionId);
      ordered.push(participant);
    }
    for (const participant of participants) {
      if (!participant.sessionId || byId.has(participant.sessionId)) {
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
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Подключение наблюдателя...</div>;
  }

  if (orderedParticipants.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Ожидание участников</div>;
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
  onStatusChange
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

  const canConnect = enabled && visible && Boolean(meetingId);
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
    if (busy || (canConnect && !call)) {
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

  const startStream = useCallback(async () => {
    if (!meetingId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const observerUserId = `observer-${meetingId}-${sessionSuffixRef.current}`;
      const response = await fetch("/api/stream/token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "spectator",
          meetingId,
          userId: observerUserId,
          userName: participantName
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "Failed to issue observer stream token");
      }

      const payload = (await response.json()) as StreamTokenResponse;
      const streamClient = new StreamVideoClient({
        apiKey: payload.apiKey,
        token: payload.token,
        user: payload.user
      });
      const streamCall = streamClient.call(payload.callType, payload.callId);
      // Allow observer to create the call to avoid race conditions
      // when spectator joins slightly earlier than candidate/HR.
      await streamCall.join({ create: true, video: false });

      setClient(streamClient);
      setCall(streamCall);
      setLocalUserId(payload.user.id);
      setHasParticipants(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start observer stream");
      // Let auto-join attempt again on next render cycle after transient failures.
      autoJoinAttemptForRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [meetingId, participantName]);

  useEffect(() => {
    if (!canConnect || call || busy) {
      return;
    }
    const autoJoinKey = meetingId ?? "no-meeting";
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, canConnect, meetingId, startStream]);

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

  return (
    <StreamParticipantShell
      title={title}
      videoRef={streamViewportRef}
      footer={
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm leading-snug">{participantName}</p>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="rounded-full px-2.5">
                {status === "joined"
                  ? "Connected"
                  : status === "no_participants"
                    ? "Connected: no participants"
                    : status === "joining"
                      ? "Connecting"
                      : status === "error"
                        ? "Error"
                        : status === "idle_hidden"
                          ? "Hidden"
                          : "Waiting meeting"}
              </Badge>
              <Badge variant={talkMode === "on" ? "default" : "outline"} className="rounded-full px-2.5">
                {talkMode === "on" ? "Talk: On" : "Talk: Off"}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {allowVisibilityToggle ? (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full px-3"
                onClick={() => onVisibleChange?.(!visible)}
              >
                {visible ? "Скрыть observer" : "Показать observer"}
              </Button>
            ) : null}
            {allowTalkToggle ? (
              <Button
                size="sm"
                variant={talkMode === "on" ? "default" : "outline"}
                className="rounded-full px-3"
                disabled={!call}
                onClick={() => onTalkModeChange?.(talkMode === "on" ? "off" : "on")}
              >
                {talkMode === "on" ? "Выключить разговор" : "Разрешить говорить"}
              </Button>
            ) : null}
            {!call && canConnect ? (
              <Button size="sm" className="rounded-full px-3" onClick={startStream} disabled={busy}>
                Подключиться
              </Button>
            ) : null}
          </div>
        </>
      }
      error={error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
    >
      {!visible && allowVisibilityToggle ? (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">Observer скрыт</div>
      ) : client && call && localUserId ? (
        <div className="h-full w-full">
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <ObserverCallBody localUserId={localUserId} onParticipantsDetected={setHasParticipants} />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          {canConnect ? "Подключение observer..." : "Ожидание активной сессии"}
        </div>
      )}
    </StreamParticipantShell>
  );
}
