"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamVideoParticipant } from "@stream-io/video-client";
import { CallControls, CallingState, ParticipantView, StreamCall, StreamTheme, StreamVideo, StreamVideoClient, useCallStateHooks } from "@stream-io/video-react-sdk";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { Badge } from "@/components/ui/badge";
import type { SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";

const AVATAR_PLACEHOLDER_SRC = "/anna.jpg";
const STREAM_OPENAI_AGENT_MODE_ENABLED = process.env.NEXT_PUBLIC_STREAM_OPENAI_AGENT_MODE === "1";

function getQueryFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(name) === "1";
}

function logHrAvatarEvent(event: string, payload: Record<string, unknown>) {
  if (typeof console === "undefined") return;
  console.info(
    JSON.stringify({
      msg: event,
      event,
      ...payload
    })
  );
}

function shouldExcludeFromHrAvatarAgentPick(userId: string): boolean {
  const id = userId.toLowerCase();
  return (
    id.startsWith("candidate-") ||
    id.startsWith("spectator-") ||
    id.startsWith("avatar-viewer-") ||
    id.startsWith("observer-") ||
    id.startsWith("viewer-")
  );
}

function pickHrAvatarStreamAgentParticipant(
  participants: StreamVideoParticipant[],
  streamCallId: string,
  realtimeSessionId: string | null | undefined
): StreamVideoParticipant | null {
  const agentPool = participants.filter((p) => {
    const id = p.userId ?? "";
    if (!id) return false;
    if (shouldExcludeFromHrAvatarAgentPick(id)) return false;
    return id.startsWith("agent_") || id.startsWith("agent-");
  });

  const preferredIds = [
    realtimeSessionId ? `agent_${realtimeSessionId}` : undefined,
    `agent_${streamCallId}`,
    `agent-${streamCallId}`
  ].filter((x): x is string => Boolean(x));

  for (const pid of preferredIds) {
    const hit = agentPool.find((p) => p.userId === pid);
    if (hit) return hit;
  }

  const getHasVideo = (p: StreamVideoParticipant): boolean => {
    const maybe = p as { videoStream?: unknown; publishedTracks?: unknown };
    if (Boolean(maybe?.videoStream)) return true;
    if (Array.isArray(maybe?.publishedTracks) && maybe.publishedTracks.includes("video")) return true;
    return false;
  };
  const getHasAudio = (p: StreamVideoParticipant): boolean => {
    const maybe = p as { audioStream?: unknown; publishedTracks?: unknown };
    if (Boolean(maybe?.audioStream)) return true;
    if (Array.isArray(maybe?.publishedTracks) && maybe.publishedTracks.includes("audio")) return true;
    return false;
  };

  return (
    agentPool.find((p) => getHasVideo(p)) ??
    agentPool.find((p) => getHasAudio(p)) ??
    agentPool[0] ??
    null
  );
}

function AvatarPlaceholder({ emphasize }: { emphasize?: boolean }) {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Image
        src={AVATAR_PLACEHOLDER_SRC}
        alt="HR ассистент NULLXES"
        fill
        sizes="(max-width: 1024px) 100vw, 480px"
        priority
        className={cn(
          "object-cover object-center",
          emphasize ? "scale-[1.02]" : undefined
        )}
      />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/35 via-transparent to-transparent" />
    </div>
  );
}

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

type AvatarCallBodyProps = {
  showStreamToolbar: boolean;
  /** Stream call id (same as meetingId in product). */
  meetingId: string;
  /** OpenAI / gateway realtime session id — used to match `agent_${sessionId}` publisher. */
  realtimeSessionId?: string | null;
  onLeave?: (err?: Error) => void | Promise<void>;
};

function AvatarCallBody({ showStreamToolbar, meetingId, realtimeSessionId, onLeave }: AvatarCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  const debugAvatar = useMemo(() => getQueryFlag("debugAvatar"), []);
  const muteAvatar = useMemo(() => getQueryFlag("muteAvatar"), []);

  const streamCallId = meetingId;

  useEffect(() => {
    for (const p of participants) {
      const id = p.userId ?? "";
      if (id && shouldExcludeFromHrAvatarAgentPick(id)) {
        logHrAvatarEvent("hr_avatar_ignored_participant", {
          meetingId: streamCallId,
          userId: id,
          reason: "excluded_internal_viewer_or_candidate"
        });
      }
    }
  }, [participants, streamCallId]);

  const avatarParticipant = useMemo(
    () => pickHrAvatarStreamAgentParticipant(participants, streamCallId, realtimeSessionId),
    [participants, realtimeSessionId, streamCallId]
  );

  const trackSummary = useMemo(() => {
    if (!avatarParticipant) return null;
    const p = avatarParticipant as unknown as {
      userId?: string;
      name?: string;
      publishedTracks?: unknown;
      videoStream?: unknown;
      audioStream?: unknown;
    };
    const publishedTracks = Array.isArray(p.publishedTracks) ? p.publishedTracks : [];
    return {
      userId: p.userId,
      name: p.name,
      publishedTracks,
      hasVideoStream: Boolean(p.videoStream) || publishedTracks.includes("video"),
      hasAudioStream: Boolean(p.audioStream) || publishedTracks.includes("audio")
    };
  }, [avatarParticipant]);

  useEffect(() => {
    logHrAvatarEvent("hr_avatar_participant_search", {
      meetingId: streamCallId,
      realtimeSessionId: realtimeSessionId ?? null,
      participants: participants.map((p) => ({
        userId: p.userId,
        name: p.name,
        publishedTracks: (p as unknown as { publishedTracks?: unknown })?.publishedTracks
      }))
    });
  }, [meetingId, participants, realtimeSessionId, streamCallId]);

  useEffect(() => {
    if (!avatarParticipant) {
      logHrAvatarEvent("hr_avatar_agent_found", { meetingId: streamCallId, agentFound: false });
      return;
    }
    logHrAvatarEvent("hr_avatar_agent_found", { meetingId: streamCallId, agentFound: true, ...(trackSummary ?? {}) });
  }, [avatarParticipant, meetingId, streamCallId, trackSummary]);

  const lastTrackKeyRef = useRef<string>("");
  useEffect(() => {
    const key = trackSummary ? JSON.stringify(trackSummary) : "none";
    if (key === lastTrackKeyRef.current) return;
    lastTrackKeyRef.current = key;
    logHrAvatarEvent("hr_avatar_agent_tracks_changed", { meetingId: streamCallId, tracks: trackSummary });
  }, [meetingId, streamCallId, trackSummary]);

  const liveVideoLoggedRef = useRef(false);
  const staticFallbackLoggedForAgentRef = useRef<string | null>(null);
  useEffect(() => {
    const hasVideo = Boolean(trackSummary?.hasVideoStream);
    const uid = trackSummary?.userId ?? "";
    if (hasVideo && !liveVideoLoggedRef.current) {
      liveVideoLoggedRef.current = true;
      logHrAvatarEvent("hr_avatar_live_video_rendered", { meetingId: streamCallId, ...(trackSummary ?? {}) });
    }
    if (!hasVideo) {
      liveVideoLoggedRef.current = false;
    }
    if (hasVideo) {
      staticFallbackLoggedForAgentRef.current = null;
    }
    if (avatarParticipant && !hasVideo && uid && staticFallbackLoggedForAgentRef.current !== uid) {
      staticFallbackLoggedForAgentRef.current = uid;
      logHrAvatarEvent("hr_avatar_static_fallback_rendered", { meetingId: streamCallId, ...(trackSummary ?? {}) });
    }
  }, [avatarParticipant, meetingId, streamCallId, trackSummary]);

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание потока аватара…</div>;
  }

  return (
    <div className="stream-call-ui relative h-full w-full">
      <div className="stream-call-layout">
        {avatarParticipant ? (
          Boolean(trackSummary?.hasVideoStream) ? (
            <ParticipantView participant={avatarParticipant} trackType="videoTrack" />
          ) : (
            <AvatarPlaceholder />
          )
        ) : STREAM_OPENAI_AGENT_MODE_ENABLED ? (
          <AvatarPlaceholder />
        ) : (
          <AvatarPlaceholder />
        )}
      </div>
      {showStreamToolbar ? (
        <div className="stream-call-controls">
          <CallControls onLeave={onLeave} />
        </div>
      ) : null}
      {debugAvatar ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[90%] rounded-xl bg-black/55 px-3 py-2 text-[11px] text-white backdrop-blur-sm">
          <div className="font-semibold">debugAvatar</div>
          <div>agentFound: {avatarParticipant ? "true" : "false"}</div>
          <div>realtimeSessionId: {String(realtimeSessionId ?? "")}</div>
          {trackSummary ? (
            <>
              <div>agentUserId: {String(trackSummary.userId ?? "")}</div>
              <div>publishedTracks: {JSON.stringify(trackSummary.publishedTracks)}</div>
              <div>hasVideoStream: {trackSummary.hasVideoStream ? "true" : "false"}</div>
              <div>hasAudioStream: {trackSummary.hasAudioStream ? "true" : "false"}</div>
            </>
          ) : null}
          <div>muteAvatar: {muteAvatar ? "true" : "false"}</div>
        </div>
      ) : null}
    </div>
  );
}

type AvatarStreamCardProps = {
  participantName: string;
  enabled: boolean;
  avatarReady: boolean;
  telemetryUnavailable?: boolean;
  meetingId: string | null;
  /** Matches gateway Stream agent id `agent_${sessionId}` when set. */
  realtimeSessionId?: string | null;
  showStreamToolbar?: boolean;
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
};

export function AvatarStreamCard({
  participantName,
  enabled,
  avatarReady,
  telemetryUnavailable = false,
  meetingId,
  realtimeSessionId = null,
  showStreamToolbar = false,
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
  mobilePip = false
}: AvatarStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const canRenderAvatarWindow = enabled && Boolean(client && call);
  const [busy, setBusy] = useState(false);
  const [inlineStatus, setInlineStatus] = useState<string | null>(null);
  const ended = Boolean(sessionEnded) || uiState === "completed";
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const connectInFlightRef = useRef(false);
  const connectEpochRef = useRef(0);
  const toastEpochRef = useRef(0);
  const callRoomId = meetingId ?? "unknown-meeting";

  const isAvatarStreamTransientError = useCallback((input: { status?: number; code?: string; message?: string }): boolean => {
    const status = input.status;
    const code = (input.code ?? "").toLowerCase();
    const message = (input.message ?? "").toLowerCase();
    if (status === 401 || status === 403) return false;
    if (status === 400) return false;
    if (status === 409 || status === 423 || status === 503) return true;

    if (
      code === "runtime.not_ready" ||
      code === "meeting.not_active" ||
      code === "stream.binding_missing" ||
      code === "observer_role_unavailable" ||
      code === "observer.readonly_enforce_failed" ||
      code === "spectator.readonly_enforcement_failed" ||
      code === "runtime.stream_call_not_ready"
    ) {
      return true;
    }

    if (message.includes("runtime snapshot is not ready")) return true;
    if (message.includes("failed to enforce readonly observer role")) return true;
    if (message.includes("readonly role is not ready")) return true;
    return false;
  }, []);

  useEffect(() => {
    // By default, do NOT forcibly mute the avatar panel; HR/spectator should be able to hear agent audio.
    // If needed for debugging / no-echo scenarios: add `?muteAvatar=1`.
    if (typeof window === "undefined") return;
    if (!getQueryFlag("muteAvatar")) return;
    const root = streamViewportRef.current;
    if (!root) return;
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
    connectEpochRef.current += 1;
    if (call) {
      await call.leave().catch(() => undefined);
    }
    if (client) {
      await client.disconnectUser().catch(() => undefined);
    }
    setCall(null);
    setClient(null);
    setInlineStatus(null);
    autoJoinAttemptForRef.current = null;
  }, [call, client]);

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
    connectInFlightRef.current = true;
    setBusy(true);
    setInlineStatus("Ждём готовность Stream…");
    const epoch = ++connectEpochRef.current;
    try {
      const backoffMs = [1000, 2000, 4000, 8000, 15000];
      const maxAttempts = backoffMs.length + 1;
      let lastFailure: { status?: number; code?: string; message?: string } | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (connectEpochRef.current !== epoch) {
          return;
        }
        if (ended) {
          return;
        }
        let response: Response | null = null;
        try {
          response = await fetch("/api/stream/token", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              role: "spectator",
              viewerKind: "hr_avatar_panel",
              meetingId,
              userId: `avatar-viewer-${meetingId}`,
              userName: participantName
            })
          });
        } catch (e) {
          lastFailure = { message: e instanceof Error ? e.message : "network_error" };
          const transient = isAvatarStreamTransientError({ message: lastFailure.message });
          if (!transient || attempt >= maxAttempts) {
            throw new Error(lastFailure.message ?? "Failed to issue HR stream token");
          }
          setInlineStatus("Видео HR-аватара подключится автоматически.");
          await new Promise((resolve) => setTimeout(resolve, backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]));
          continue;
        }

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as StreamTokenErrorPayload;
          lastFailure = { status: response.status, code: payload.code, message: payload.message };
          const transient = isAvatarStreamTransientError(lastFailure);
          if (!transient) {
            throw new Error(payload.message ?? "Failed to issue HR stream token");
          }
          if (attempt >= maxAttempts) {
            throw new Error(payload.message ?? "Stream is not ready yet");
          }
          setInlineStatus("Видео HR-аватара подключится автоматически.");
          await new Promise((resolve) => setTimeout(resolve, backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]));
          continue;
        }

        const payload = (await response.json()) as StreamTokenResponse;
        // Stream SDK HTTP by MagistrTheOne 
        let streamClient: StreamVideoClient | null = new StreamVideoClient({
          apiKey: payload.apiKey,
          token: payload.token,
          user: payload.user,
          options: { timeout: 60_000 }
        });
        let streamCall: ReturnType<StreamVideoClient["call"]> | null = null;

        try {
          streamCall = streamClient.call(payload.callType, payload.callId);
          await streamCall.camera.disable().catch(() => undefined);
          await streamCall.microphone.disable().catch(() => undefined);
          await streamCall.join({ create: false, video: false } as Parameters<typeof streamCall.join>[0]);
          await streamCall.camera.disable().catch(() => undefined);
          await streamCall.microphone.disable().catch(() => undefined);
        } catch (err) {
          await streamCall?.leave().catch(() => undefined);
          await streamClient?.disconnectUser().catch(() => undefined);
          streamCall = null;
          streamClient = null;
          throw err;
        }

        if (connectEpochRef.current !== epoch) {
          await streamCall.leave().catch(() => undefined);
          await streamClient.disconnectUser().catch(() => undefined);
          return;
        }
        setClient(streamClient);
        setCall(streamCall);
        setInlineStatus(null);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Не удалось подключить видео HR";
      if (toastEpochRef.current !== epoch) {
        toastEpochRef.current = epoch;
        toast.error("Видео HR-аватара", { description: msg });
      }
      setInlineStatus(msg);
    } finally {
      connectInFlightRef.current = false;
      setBusy(false);
    }
  }, [ended, isAvatarStreamTransientError, meetingId, participantName]);

  const hrStatusLabel = useMemo(() => {
    if (ended) {
      return "Сессия завершена";
    }
    if (canRenderAvatarWindow) {
      return "В эфире";
    }
    if (!enabled || !meetingId) {
      return "Ожидаем запуск";
    }
    if (busy || !call) {
      return "Подключаемся…";
    }
    return "Подключаемся…";
  }, [busy, call, canRenderAvatarWindow, enabled, ended, meetingId]);

  useEffect(() => {
    if (!enabled || ended || !meetingId || call || busy) {
      return;
    }
    const autoJoinKey = meetingId;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, enabled, ended, meetingId, startStream]);

  useEffect(() => {
    if (enabled && meetingId) {
      return;
    }
    void disconnectStream();
  }, [disconnectStream, enabled, meetingId]);

  useEffect(() => {
    if (ended) {
      void disconnectStream();
    }
  }, [disconnectStream, ended]);

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
      compact={mobilePip}
      videoClassName={cn(
        !canRenderAvatarWindow && "bg-slate-300/70",
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
                title={
                  aiPaused
                    ? "Возобновить ответы HR аватара"
                    : pauseResumeCopy === "stop_bot"
                      ? "Приостановить ответы HR аватара"
                      : "Поставить HR аватар на паузу"
                }
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
      {canRenderAvatarWindow && client && call ? (
        <div className={cn("h-full w-full", ended && "pointer-events-none opacity-80")}>
          <StreamVideo client={client}>
            <StreamTheme>
              <StreamCall call={call}>
                <AvatarCallBody
                  showStreamToolbar={showStreamToolbar}
                  meetingId={callRoomId}
                  realtimeSessionId={realtimeSessionId}
                  onLeave={handleLeaveFromControls}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
        </div>
      ) : ended ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-sm font-medium text-slate-700">{hrStatusLabel}</p>
        </div>
      ) : (
        <div className="relative h-full w-full">
          <AvatarPlaceholder emphasize={emphasizePrimary} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 px-4 pb-3 text-center">
            {(busy || (enabled && meetingId && !call)) ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-white/90" aria-hidden />
            ) : null}
            <p className="rounded-full bg-black/45 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {hrStatusLabel}
            </p>
            {inlineStatus ? (
              <p className="rounded-full bg-black/35 px-3 py-1 text-[11px] text-white/90 backdrop-blur-sm">
                {inlineStatus}
              </p>
            ) : null}
            {!canRenderAvatarWindow && telemetryUnavailable ? (
              <p className="rounded-full bg-black/35 px-3 py-1 text-[11px] text-white/90 backdrop-blur-sm">
                Телеметрия недоступна, ждём фактический видеопоток
              </p>
            ) : null}
            {!canRenderAvatarWindow && avatarReady && !telemetryUnavailable ? (
              <p className="rounded-full bg-black/35 px-3 py-1 text-[11px] text-white/90 backdrop-blur-sm">
                Сигнал готовности получен, подключаем поток…
              </p>
            ) : null}
          </div>
        </div>
      )}
    </StreamParticipantShell>
  );
}
