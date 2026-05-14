"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { isApiRequestError } from "@/lib/api";
import {
  getInterviewLivekitData,
  postDeinit,
  postLivekitToken,
  postMeetingPingStatus,
  postMeetingsStartV2,
  type GetInterviewLivekitDataResponse
} from "@/lib/jobai-webrtc-v2-api";
import { deriveMainUiStatus, type MainUIStatus } from "@/lib/livekit-interview-ui-state";

const PING_MS = 30_000;
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_DELAY_MS = 800;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface UseJobaiLiveKitInterviewV2Options {
  inviteToken: string;
  liveKitParticipantIdentity: string;
  liveKitDisplayName?: string;
  /** Публичный базовый URL realtime-gateway для WS п.2.4, например `https://api.example.com` (токен в query). */
  controlWebSocketBaseUrl?: string;
}

export interface UseJobaiLiveKitInterviewV2Result {
  mainUIStatus: MainUIStatus;
  bootstrap: GetInterviewLivekitDataResponse | null;
  bootstrapError: string | null;
  liveKitRoom: Room | null;
  isBusy: boolean;
  load: () => Promise<void>;
  startInterview: (opts?: { agentRTMPURL?: string }) => Promise<void>;
  endInterview: () => Promise<void>;
}

/**
 * Оркестрация п.1.2 → 1.5 → пинг 1.4 → 1.3 и LiveKit Room (ЧТЗ WebRTC–JobAI V2).
 * Control WS: при `controlWebSocketBaseUrl` открывается `…/ws/meeting/:id?token=…` (поддержка на gateway).
 */
export function useJobaiLiveKitInterviewV2(options: UseJobaiLiveKitInterviewV2Options): UseJobaiLiveKitInterviewV2Result {
  const [bootstrap, setBootstrap] = useState<GetInterviewLivekitDataResponse | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [liveKitRoom, setLiveKitRoom] = useState<Room | null>(null);
  const [hasStartedSession, setHasStartedSession] = useState(false);
  const [pingStopped, setPingStopped] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomRef = useRef<Room | null>(null);
  const controlWsRef = useRef<WebSocket | null>(null);

  const clearPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const mainUIStatus: MainUIStatus = deriveMainUiStatus({
    meetingAtIso: bootstrap?.meetingAt ?? new Date(0).toISOString(),
    hasStartedSession,
    pingStopped
  });

  const load = useCallback(async () => {
    setBootstrapError(null);
    setIsBusy(true);
    let lastErr = "unknown";
    for (let i = 0; i < BOOTSTRAP_ATTEMPTS; i += 1) {
      try {
        const data = await getInterviewLivekitData(options.inviteToken);
        setBootstrap(data);
        setIsBusy(false);
        return;
      } catch (e: unknown) {
        lastErr = isApiRequestError(e) ? e.message : e instanceof Error ? e.message : "load_failed";
        if (i < BOOTSTRAP_ATTEMPTS - 1) {
          await sleep(BOOTSTRAP_DELAY_MS);
        }
      }
    }
    setBootstrapError(lastErr);
    setIsBusy(false);
  }, [options.inviteToken]);

  const startInterview = useCallback(
    async (opts?: { agentRTMPURL?: string }) => {
      if (!bootstrap) throw new Error("bootstrap_required");
      setIsBusy(true);
      try {
        const lk = bootstrap.liveKitResponse;
        const agentRtmpFromIngress = lk.ingress?.agentRTMPURL ?? lk.ingress?.livekitIngressRtmpUrl;
        await postMeetingsStartV2({
          meetingId: bootstrap.meetingId,
          meetingControlKey: bootstrap.meetingControlKey,
          agentRTMPURL: opts?.agentRTMPURL ?? agentRtmpFromIngress
        });
        setHasStartedSession(true);

        if (lk.configured && lk.serverUrl && lk.roomName) {
          const tokenPayload = await postLivekitToken({
            meetingId: lk.roomName,
            identity: options.liveKitParticipantIdentity,
            name: options.liveKitDisplayName
          });
          const room = new Room();
          await room.connect(tokenPayload.serverUrl, tokenPayload.token);
          roomRef.current = room;
          setLiveKitRoom(room);
          room.on(RoomEvent.Disconnected, () => {
            roomRef.current = null;
            setLiveKitRoom(null);
          });
        }

        clearPing();
        pingTimerRef.current = setInterval(() => {
          void postMeetingPingStatus(bootstrap.meetingId, bootstrap.meetingControlKey)
            .then((r) => {
              if (r.status === "meeting_stopped") {
                setPingStopped(true);
                clearPing();
              }
            })
            .catch(() => undefined);
        }, PING_MS);

        if (options.controlWebSocketBaseUrl) {
          const base = new URL(options.controlWebSocketBaseUrl);
          const wsProto = base.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${wsProto}//${base.host}/ws/meeting/${bootstrap.meetingId}?token=${encodeURIComponent(bootstrap.meetingControlKey)}`;
          controlWsRef.current?.close();
          controlWsRef.current = new WebSocket(wsUrl);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [bootstrap, clearPing, options.controlWebSocketBaseUrl, options.liveKitDisplayName, options.liveKitParticipantIdentity]
  );

  const endInterview = useCallback(async () => {
    if (!bootstrap) return;
    setIsBusy(true);
    try {
      await postDeinit(bootstrap.meetingId, bootstrap.meetingControlKey);
      setPingStopped(true);
      clearPing();
      controlWsRef.current?.close();
      controlWsRef.current = null;
      roomRef.current?.disconnect();
      roomRef.current = null;
      setLiveKitRoom(null);
    } finally {
      setIsBusy(false);
    }
  }, [bootstrap, clearPing]);

  useEffect(() => {
    return () => {
      clearPing();
      controlWsRef.current?.close();
      roomRef.current?.disconnect();
    };
  }, [clearPing]);

  return {
    mainUIStatus,
    bootstrap,
    bootstrapError,
    liveKitRoom,
    isBusy,
    load,
    startInterview,
    endInterview
  };
}
