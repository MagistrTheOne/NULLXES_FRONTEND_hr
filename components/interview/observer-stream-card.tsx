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
import {
  Loader2,
  Maximize2,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
  VolumeX
} from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
export type ObserverAccessMode = "internal_dashboard" | "external_signed";
export type ObserverConnectionStatus =
  | "waiting_meeting"
  | "joining"
  | "joined"
  | "no_participants"
  | "error"
  | "idle_hidden";
type ObserverConnectionPhase = "connecting" | "connected" | "reconnecting" | "failed";
type ObserverViewMode = "waiting" | "live" | "ended";

const OBSERVER_TOKEN_TIMEOUT_MS = 20_000;
// Stream SFU join for readonly spectators can take longer (role propagation + SFU WS).
const OBSERVER_JOIN_TIMEOUT_MS = 45_000;
const OBSERVER_MAX_ATTEMPTS = 6;
const OBSERVER_RETRY_BACKOFF_MS = 1_200;
const OBSERVER_RECONNECT_LOCK_MS = 1_500;
const OBSERVER_NO_PARTICIPANTS_GRACE_MS = 7_000;
const OBSERVER_NO_PARTICIPANTS_RECONNECT_MAX = 3;
const OBSERVER_JOIN_RETRY_ATTEMPTS = 2;
const OBSERVER_JOIN_RETRY_DELAY_MS = 1_500;
const OBSERVER_PARTICIPANT_WATCHDOG_MS = 7_000;

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

function normalizeObserverStreamError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("signaling ws channel error") ||
    lower.includes("websocket") ||
    lower.includes("sfuclientws")
  ) {
    return "SFU signaling временно недоступен (WS). Проверьте сеть/VPN/firewall и повторите подключение.";
  }
  return message;
}

function isObserverTransientMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("observer_role_unavailable") ||
    lower.includes("readonly role") ||
    lower.includes("observer readonly role") ||
    lower.includes("stream.binding_missing") ||
    lower.includes("meeting.not_active") ||
    lower.includes("runtime.not_ready") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("abort")
  );
}

type PipPosition = { x: number; y: number };

function clampPipPosition(position: PipPosition, root: HTMLElement, pip: HTMLElement): PipPosition {
  const maxX = Math.max(8, root.clientWidth - pip.offsetWidth - 8);
  const maxY = Math.max(8, root.clientHeight - pip.offsetHeight - 8);
  return {
    x: Math.min(Math.max(8, position.x), maxX),
    y: Math.min(Math.max(8, position.y), maxY)
  };
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
  agentAvatarImageUrl?: string | null;
  onParticipantsDetected?: (hasParticipants: boolean) => void;
  sessionMirrorLayout?: boolean;
  candidateVideoContainerRef?: { current: HTMLDivElement | null };
};

/** Две колонки как у кандидата: кандидат | HR (внутри одного StreamCall). */
type ObserverSplitDashboardProps = {
  localUserId: string;
  candidateDisplayName: string;
  agentAvatarImageUrl?: string | null;
  onParticipantsDetected?: (hasParticipants: boolean) => void;
  candidateVideoContainerRef?: { current: HTMLDivElement | null };
};

function ObserverSplitDashboard({
  localUserId,
  candidateDisplayName,
  agentAvatarImageUrl = null,
  onParticipantsDetected,
  candidateVideoContainerRef
}: ObserverSplitDashboardProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.info(
      "[observer-participants]",
      participants.map((p) => {
        const userId = typeof p.userId === "string" ? p.userId : "";
        const name = typeof (p as unknown as { name?: unknown }).name === "string" ? ((p as unknown as { name?: string }).name as string) : "";
        const sessionId =
          typeof (p as unknown as { sessionId?: unknown }).sessionId === "string"
            ? ((p as unknown as { sessionId?: string }).sessionId as string)
            : "";
        const publishedTracks = (p as unknown as { publishedTracks?: unknown }).publishedTracks;
        const publishedTracksArr = Array.isArray(publishedTracks) ? (publishedTracks as unknown[]) : [];
        const hasVideo =
          Boolean((p as unknown as { videoStream?: unknown }).videoStream) || publishedTracksArr.includes("video");
        const hasAudio =
          Boolean((p as unknown as { audioStream?: unknown }).audioStream) || publishedTracksArr.includes("audio");
        return {
          userId: userId || null,
          name: name || null,
          sessionId: sessionId || null,
          hasVideo,
          hasAudio,
          isLocal: userId === localUserId
        };
      })
    );
  }, [localUserId, participants]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const snapshot = participants.map((p) => {
      const userId = typeof p.userId === "string" ? p.userId : "";
      const user = (p as unknown as { user?: { name?: string; role?: string } }).user;
      const tracks = (p as unknown as { publishedTracks?: unknown }).publishedTracks;
      return {
        userId: userId || null,
        name: typeof user?.name === "string" ? user.name : null,
        role: typeof user?.role === "string" ? user.role : null,
        sessionId:
          typeof (p as unknown as { sessionId?: unknown }).sessionId === "string"
            ? ((p as unknown as { sessionId?: string }).sessionId as string)
            : null,
        isLocalParticipant: Boolean((p as unknown as { isLocalParticipant?: unknown }).isLocalParticipant),
        isSpeaking: Boolean((p as unknown as { isSpeaking?: unknown }).isSpeaking),
        publishedTracksType: tracks ? typeof tracks : null,
        guessed: {
          isCandidate: userId.startsWith("candidate-"),
          isAgent: userId.startsWith("agent-") || userId.startsWith("agent_"),
          isViewer: userId.startsWith("viewer-") || userId.startsWith("avatar-viewer-")
        }
      };
    });
    console.info("[stream-participants-diagnostics]", {
      scope: "observer-split-dashboard",
      localUserId,
      count: snapshot.length,
      participants: snapshot
    });
  }, [localUserId, participants]);

  const remoteCount = useMemo(
    () => participants.filter((p) => p.userId !== localUserId).length,
    [localUserId, participants]
  );

  useEffect(() => {
    onParticipantsDetected?.(remoteCount > 0);
  }, [onParticipantsDetected, remoteCount]);

  const { candidateParticipant, agentParticipant } = useMemo(() => {
    const remotes = participants.filter((p) => {
      const userId = typeof p.userId === "string" ? p.userId : "";
      return Boolean(userId) && userId !== localUserId;
    });

    const getName = (p: (typeof participants)[number]): string => {
      const direct = typeof (p as unknown as { name?: unknown }).name === "string" ? ((p as unknown as { name?: string }).name as string) : "";
      const user = (p as unknown as { user?: { name?: string } }).user;
      const fromUser = typeof user?.name === "string" ? user.name : "";
      return (direct || fromUser || "").trim();
    };

    const hasPublished = (p: (typeof participants)[number], kind: "video" | "audio"): boolean => {
      const publishedTracks = (p as unknown as { publishedTracks?: unknown }).publishedTracks;
      const arr = Array.isArray(publishedTracks) ? (publishedTracks as unknown[]) : [];
      return arr.includes(kind);
    };

    const hasVideo = (p: (typeof participants)[number]): boolean =>
      Boolean((p as unknown as { videoStream?: unknown }).videoStream) || hasPublished(p, "video");

    const normalize = (value: string) => value.toLowerCase();

    const candidateBySignal =
      remotes.find((p) => normalize(p.userId ?? "").includes("candidate")) ??
      remotes.find((p) => {
        const name = normalize(getName(p));
        return name.includes("candidate") || name.includes("candidat") || name.includes("кандидат");
      }) ??
      remotes.find((p) => hasVideo(p)) ??
      null;

    const agentBySignal =
      remotes.find((p) => {
        const id = normalize(p.userId ?? "");
        return id.includes("agent") || id.includes("hr");
      }) ??
      remotes.find((p) => {
        const name = normalize(getName(p));
        return (
          name.includes("hr") ||
          name.includes("ассистент") ||
          name.includes("assistant") ||
          name.includes("agent") ||
          name.includes("avatar")
        );
      }) ??
      null;

    const remotesWithVideo = remotes.filter((p) => hasVideo(p));

    let candidate = candidateBySignal;
    let agent = agentBySignal;

    if (candidate && agent && candidate.userId === agent.userId) {
      agent = null;
    }

    if (!candidate) {
      candidate = remotesWithVideo[0] ?? remotes[0] ?? null;
    }

    if (!agent) {
      const first = remotesWithVideo[0]?.userId;
      agent = remotesWithVideo.find((p) => p.userId !== first) ?? remotes.find((p) => p.userId !== candidate?.userId) ?? null;
    }

    // Final guard: never return local participant.
    if (candidate?.userId === localUserId) candidate = null;
    if (agent?.userId === localUserId) agent = null;

    return { candidateParticipant: candidate, agentParticipant: agent };
  }, [localUserId, participants]);

  const leftBadge = candidateParticipant ? "В эфире" : state === CallingState.JOINING ? "Подключение…" : "Ожидание";
  const rightBadge = agentParticipant ? "В эфире" : state === CallingState.JOINING ? "Подключение…" : "Ожидание";

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return (
      <div className="grid h-full min-h-0 w-full grid-cols-1 gap-4 p-1 md:grid-cols-2 md:gap-5 lg:gap-6">
        <StreamParticipantShell
          title="Кандидат"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{candidateDisplayName}</p>
              <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                <span className="mr-1 text-slate-500" aria-hidden>
                  ●
                </span>
                Поток не подключён
              </Badge>
            </div>
          }
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-slate-600">Подключение наблюдателя…</p>
          </div>
        </StreamParticipantShell>
        <StreamParticipantShell
          title="HR аватар"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">HR ассистент</p>
              <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                <span className="mr-1 text-slate-500" aria-hidden>
                  ●
                </span>
                Поток не подключён
              </Badge>
            </div>
          }
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-slate-600">Подключение наблюдателя…</p>
          </div>
        </StreamParticipantShell>
      </div>
    );
  }

  if (remoteCount === 0) {
    return (
      <div className="grid h-full min-h-0 w-full grid-cols-1 gap-4 p-1 md:grid-cols-2 md:gap-5 lg:gap-6">
        <StreamParticipantShell
          title="Кандидат"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{candidateDisplayName}</p>
              <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                <span className="mr-1 text-amber-600" aria-hidden>
                  ●
                </span>
                Ожидание участников
              </Badge>
            </div>
          }
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-600">
            Ожидание кандидата
          </div>
        </StreamParticipantShell>
        <StreamParticipantShell
          title="HR аватар"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">HR ассистент</p>
              <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                <span className="mr-1 text-amber-600" aria-hidden>
                  ●
                </span>
                Ожидание участников
              </Badge>
            </div>
          }
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-600">
            Ожидание HR аватара
          </div>
        </StreamParticipantShell>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 w-full grid-cols-1 gap-4 p-1 md:grid-cols-2 md:gap-5 lg:gap-6">
      <StreamParticipantShell
        title="Кандидат"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{candidateDisplayName}</p>
            <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
              <span
                className={cn("mr-1", candidateParticipant ? "text-emerald-600" : "text-slate-400")}
                aria-hidden
              >
                ●
              </span>
              {leftBadge}
            </Badge>
          </div>
        }
      >
        <div ref={candidateVideoContainerRef} className="h-full w-full">
          {candidateParticipant ? (
            <ParticipantView participant={candidateParticipant} trackType="videoTrack" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание кандидата</div>
          )}
          {process.env.NODE_ENV !== "production" ? (
            <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md bg-black/55 px-2 py-1 text-[10px] leading-snug text-white">
              candidate: {(candidateParticipant?.userId as string | undefined) ?? "—"} ·{" "}
              {((candidateParticipant as unknown as { name?: unknown })?.name as string | undefined) ?? "—"}
            </div>
          ) : null}
        </div>
      </StreamParticipantShell>
      <StreamParticipantShell
        title="HR аватар"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
            <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">HR ассистент</p>
            <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
              <span className={cn("mr-1", agentParticipant ? "text-emerald-600" : "text-slate-400")} aria-hidden>
                ●
              </span>
              {rightBadge}
            </Badge>
          </div>
        }
      >
        {agentParticipant ? (
          (() => {
            const hasAgentVideo =
              Boolean((agentParticipant as unknown as { videoStream?: unknown })?.videoStream) ||
              (Array.isArray((agentParticipant as unknown as { publishedTracks?: unknown })?.publishedTracks) &&
                ((agentParticipant as unknown as { publishedTracks: unknown[] }).publishedTracks).includes("video"));
            if (hasAgentVideo) {
              return <ParticipantView participant={agentParticipant} trackType="videoTrack" />;
            }
            if (agentAvatarImageUrl) {
              return (
                <div className="relative h-full w-full">
                  <ParticipantView participant={agentParticipant} trackType="videoTrack" />
                  <Image
                    src={agentAvatarImageUrl}
                    alt="HR ассистент"
                    fill
                    sizes="(max-width: 1024px) 100vw, 480px"
                    className="object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                  {agentParticipant.isSpeaking ? (
                    <Badge className="absolute right-3 top-3 bg-emerald-500/90 text-white">Говорит</Badge>
                  ) : null}
                </div>
              );
            }
            return <ParticipantView participant={agentParticipant} trackType="videoTrack" />;
          })()
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание HR аватара</div>
        )}
        {process.env.NODE_ENV !== "production" ? (
          <div className="absolute bottom-2 left-2 right-2 z-10 rounded-md bg-black/55 px-2 py-1 text-[10px] leading-snug text-white">
            agent: {(agentParticipant?.userId as string | undefined) ?? "—"} ·{" "}
            {((agentParticipant as unknown as { name?: unknown })?.name as string | undefined) ?? "—"}
          </div>
        ) : null}
      </StreamParticipantShell>
    </div>
  );
}

function ObserverCallBody({
  localUserId,
  agentAvatarImageUrl = null,
  onParticipantsDetected,
  sessionMirrorLayout = false,
  candidateVideoContainerRef
}: ObserverCallBodyProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  useEffect(() => {
    onParticipantsDetected?.(participants.some((p) => p.userId && p.userId !== localUserId));
  }, [localUserId, onParticipantsDetected, participants]);

  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Подключение наблюдателя…</div>;
  }

  if (!sessionMirrorLayout) {
    const candidateParticipant =
      participants.find((participant) => participant.userId?.startsWith("candidate-")) ?? null;
    const agentParticipant =
      participants.find((participant) => participant.userId?.startsWith("agent-")) ??
      participants.find((participant) => participant.userId?.startsWith("agent_")) ??
      null;
    return (
      <div className="grid h-full min-h-0 w-full grid-cols-1 gap-4 p-1 md:grid-cols-2 md:gap-5">
        <StreamParticipantShell
          title="Кандидат"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">Кандидат</p>
            </div>
          }
        >
          <div ref={candidateVideoContainerRef} className="h-full w-full">
            {candidateParticipant ? (
              <ParticipantView participant={candidateParticipant} trackType="videoTrack" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание кандидата</div>
            )}
          </div>
        </StreamParticipantShell>
        <StreamParticipantShell
          title="HR аватар"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
              <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">HR ассистент</p>
            </div>
          }
        >
          {agentParticipant ? (
            (() => {
              const hasAgentVideo =
                Boolean((agentParticipant as unknown as { videoStream?: unknown })?.videoStream) ||
                (Array.isArray((agentParticipant as unknown as { publishedTracks?: unknown })?.publishedTracks) &&
                  ((agentParticipant as unknown as { publishedTracks: unknown[] }).publishedTracks).includes("video"));
              if (hasAgentVideo) {
                return <ParticipantView participant={agentParticipant} trackType="videoTrack" />;
              }
              if (agentAvatarImageUrl) {
                return (
                  <div className="relative h-full w-full">
                    <ParticipantView participant={agentParticipant} trackType="videoTrack" />
                    <Image
                      src={agentAvatarImageUrl}
                      alt="HR ассистент"
                      fill
                      sizes="(max-width: 1024px) 100vw, 480px"
                      className="object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                    {agentParticipant.isSpeaking ? (
                      <Badge className="absolute right-3 top-3 bg-emerald-500/90 text-white">Говорит</Badge>
                    ) : null}
                  </div>
                );
              }
              return <ParticipantView participant={agentParticipant} trackType="videoTrack" />;
            })()
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание HR аватара</div>
          )}
        </StreamParticipantShell>
      </div>
    );
  }

  const candidate = participants.find((participant) => participant.userId?.startsWith("candidate-")) ?? null;
  const agent =
    participants.find((participant) => participant.userId?.startsWith("agent-")) ??
    participants.find((participant) => participant.userId?.startsWith("agent_")) ??
    null;
  const avatar = agent;
  const extra = participants
    .filter(
      (participant) =>
        participant.sessionId &&
        participant.userId !== localUserId &&
        participant.sessionId !== candidate?.sessionId &&
        participant.sessionId !== agent?.sessionId
    )
    .slice(0, 2);

  return (
    <div className="grid h-full min-h-0 w-full grid-cols-1 gap-2 p-2 md:grid-cols-3 md:gap-3">
      <div className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50 md:col-span-2">
        <div ref={candidateVideoContainerRef} className="h-full w-full">
          {candidate ? (
            <ParticipantView participant={candidate} trackType="videoTrack" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание кандидата</div>
          )}
        </div>
      </div>
      <div className="grid gap-2 md:grid-rows-2">
        <div className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
          {avatar ? (
            (() => {
              const hasAgentVideo =
                Boolean((avatar as unknown as { videoStream?: unknown })?.videoStream) ||
                (Array.isArray((avatar as unknown as { publishedTracks?: unknown })?.publishedTracks) &&
                  ((avatar as unknown as { publishedTracks: unknown[] }).publishedTracks).includes("video"));
              if (hasAgentVideo) {
                return <ParticipantView participant={avatar} trackType="videoTrack" />;
              }
              if (agentAvatarImageUrl) {
                return (
                  <div className="relative h-full w-full">
                    <ParticipantView participant={avatar} trackType="videoTrack" />
                    <Image
                      src={agentAvatarImageUrl}
                      alt="HR ассистент"
                      fill
                      sizes="(max-width: 1024px) 100vw, 480px"
                      className="object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                    {avatar.isSpeaking ? (
                      <Badge className="absolute right-3 top-3 bg-emerald-500/90 text-white">Говорит</Badge>
                    ) : null}
                  </div>
                );
              }
              return <ParticipantView participant={avatar} trackType="videoTrack" />;
            })()
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание HR аватара</div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1">
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
  observerAccessMode: ObserverAccessMode;
  enabled: boolean;
  visible: boolean;
  talkMode: ObserverTalkMode;
  /** Optional HR avatar image URL when agent has no video track. */
  agentAvatarImageUrl?: string | null;
  onVisibleChange?: (nextVisible: boolean) => void;
  onTalkModeChange?: (nextTalkMode: ObserverTalkMode) => void;
  allowVisibilityToggle?: boolean;
  allowTalkToggle?: boolean;
  mutePlayback?: boolean;
  title?: string;
  onStatusChange?: (status: ObserverConnectionStatus) => void;
  sessionEnded?: boolean;
  uiState?: SessionUIState;
  /** External signed spectator join token (from /join/spectator/:token). */
  joinToken?: string | null;
  /** One-time observer session ticket for external signed spectators. */
  observerTicket?: string | null;
  /** Stable spectator key for reconnect identity (if available from URL/parent). */
  viewerKey?: string | null;
  /** Called when observerTicket was refreshed and should be persisted by parent. */
  onObserverTicketRefresh?: (ticket: string) => void;
  /** Called when observerTicket is no longer usable and should be cleared by parent. */
  onObserverTicketInvalid?: () => void;
  /** Компоновка в стиле "полотно сессии": кандидат слева, аватар справа. */
  sessionMirrorLayout?: boolean;
  /** Мини self-view наблюдателя (локальная камера/микрофон) поверх потока. */
  showSelfPreview?: boolean;
  /** Точный статус ожидания из родительского orchestration-слоя spectator page. */
  waitingReason?: string | null;
  /**
   * Раскладка страницы наблюдателя: две колонки «Кандидат | HR аватар» как у кандидата,
   * общая панель управления и PiP «наблюдатель». Для HR-колонки в interview-shell не включать.
   */
  spectatorDashboardLayout?: boolean;
  /** Подпись под колонкой «Кандидат» (имя из JobAI). */
  candidateDisplayName?: string | null;
};

export function ObserverStreamCard({
  participantName,
  meetingId,
  streamCallId = null,
  streamCallType = null,
  observerAccessMode,
  enabled,
  visible,
  talkMode,
  agentAvatarImageUrl = null,
  onVisibleChange,
  onTalkModeChange,
  allowVisibilityToggle = true,
  allowTalkToggle = true,
  mutePlayback = true,
  title = "Наблюдатель",
  onStatusChange,
  sessionEnded = false,
  uiState,
  joinToken = null,
  observerTicket = null,
  viewerKey = null,
  onObserverTicketRefresh,
  onObserverTicketInvalid,
  sessionMirrorLayout = false,
  showSelfPreview = false,
  waitingReason = null,
  spectatorDashboardLayout = false,
  candidateDisplayName = null
}: ObserverStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const clientRef = useRef<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const callRef = useRef<ReturnType<StreamVideoClient["call"]> | null>(null);
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transientStatus, setTransientStatus] = useState<string | null>(null);
  const [hasParticipants, setHasParticipants] = useState<boolean | null>(null);
  const [selfPreviewStream, setSelfPreviewStream] = useState<MediaStream | null>(null);
  const [selfCameraEnabled, setSelfCameraEnabled] = useState(true);
  const [selfPreviewError, setSelfPreviewError] = useState<string | null>(null);
  const [playbackMuted, setPlaybackMuted] = useState(mutePlayback);
  const [focusCandidateOnly, setFocusCandidateOnly] = useState(false);
  const streamViewportRef = useRef<HTMLDivElement | null>(null);
  const splitPlaybackRootRef = useRef<HTMLDivElement | null>(null);
  const selfPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const autoJoinAttemptForRef = useRef<string | null>(null);
  const connectEpochRef = useRef(0);
  const [persistedViewerKey, setPersistedViewerKey] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ObserverConnectionPhase>("connecting");
  const reconnectLockUntilRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const noParticipantsReconnectCountRef = useRef<Record<string, number>>({});
  const participantWatchdogRef = useRef<number | null>(null);
  const sfuRejoinInFlightRef = useRef(false);
  const lastSfuRejoinAtMsRef = useRef(0);
  const currentTicketRef = useRef<string | null>(null);
  const pipRef = useRef<HTMLDivElement | null>(null);
  const candidateVideoContainerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [pipPosition, setPipPosition] = useState<PipPosition | null>(null);
  const [pipPinned, setPipPinned] = useState(true);

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const viewerKind =
    observerAccessMode === "internal_dashboard" ? ("internal_observer_dashboard" as const) : null;
  const suppressErrorToasts = observerAccessMode === "internal_dashboard";
  const viewMode: ObserverViewMode = useMemo(() => {
    if (ended) return "ended";
    if (client && call && localUserId) return "live";
    return "waiting";
  }, [call, client, ended, localUserId]);
  const accessReady = useMemo(() => {
    const callId = (streamCallId ?? "").trim();
    const callType = (streamCallType ?? "").trim();
    const bindingValid =
      Boolean(meetingId) &&
      Boolean(callId) &&
      Boolean(callType) &&
      callId !== "unknown" &&
      callType !== "unknown";
    if (!bindingValid) return false;
    if (observerAccessMode === "internal_dashboard") return true;
    return Boolean(joinToken?.trim()) && Boolean(observerTicket?.trim());
  }, [joinToken, meetingId, observerAccessMode, observerTicket, streamCallId, streamCallType]);

  const canConnect = enabled && visible && accessReady && !ended;

  useEffect(() => {
    if (observerAccessMode === "external_signed") {
      currentTicketRef.current = observerTicket?.trim() || null;
    } else {
      currentTicketRef.current = null;
    }
  }, [observerAccessMode, observerTicket]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.log("[observer-access]", {
      mode: observerAccessMode,
      accessReady,
      meetingId,
      streamCallId,
      streamCallType
    });
  }, [accessReady, meetingId, observerAccessMode, streamCallId, streamCallType]);
  const emitObserverAuditEvent = useCallback(
    (type: "observer_join_attempt" | "observer_joined" | "observer_no_participants_retry", payload: Record<string, unknown>) => {
      if (!meetingId) return;
      void fetch(`/api/gateway/runtime/${encodeURIComponent(meetingId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "realtime.session.event",
          actor: "observer_ui",
          payload: { telemetryType: type, ...payload }
        })
      }).catch(() => undefined);
    },
    [meetingId]
  );
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
  }, [allowVisibilityToggle, busy, call, enabled, error, hasParticipants, meetingId, visible]);

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
      return null;
    }
    if (transientStatus) {
      return transientStatus;
    }
    if (!meetingId || !enabled) {
      return waitingReason ?? "Интервью еще не запущено. Подключение доступно после активации сессии кандидата.";
    }
    if (!streamCallId || !streamCallType) {
      if (observerAccessMode === "internal_dashboard") {
        return waitingReason ?? "Ждём Stream call";
      }
      return waitingReason ?? "Ждём конфигурацию Stream call от runtime.";
    }
    if (observerAccessMode === "external_signed" && !observerTicket?.trim()) {
      return waitingReason ?? "Подготавливаем доступ наблюдателя…";
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
    if (call && connectionPhase === "connected") {
      if (status === "no_participants") {
        return "Подключено. Ждём участников сессии (кандидат/HR).";
      }
      return "Наблюдатель подключен к активной сессии.";
    }
    if (call) {
      return "Подключение к звонку…";
    }
    if (canConnect && !busy && !call) {
      return "Нажмите «Подключиться», чтобы открыть наблюдение.";
    }
    return waitingReason ?? "Ожидание запуска. Подключение выполнится автоматически, когда сессия будет доступна.";
  }, [
    busy,
    call,
    connectionPhase,
    enabled,
    ended,
    error,
    meetingId,
    canConnect,
    observerAccessMode,
    observerTicket,
    status,
    streamCallId,
    streamCallType,
    transientStatus,
    waitingReason
  ]);

  const statusBadgeLabel = useMemo(() => {
    if (ended) return "Завершено";
    if (error) return "Ошибка видео";
    if (busy || connectionPhase === "reconnecting") return "Подключаемся…";
    if (status === "no_participants") return "Подключено, ждём";
    if (call) return "В эфире";
    if (!enabled || !meetingId) return "Ожидание запуска";
    return "Не в эфире";
  }, [busy, call, connectionPhase, enabled, ended, error, meetingId, status]);

  // TODO(stream-audio): add explicit remote audio renderer for observer; ParticipantView trackType="videoTrack" may not bind audio tracks.

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    setPlaybackMuted(mutePlayback);
  }, [mutePlayback]);

  useEffect(() => {
    const root = spectatorDashboardLayout ? splitPlaybackRootRef.current : streamViewportRef.current;
    if (!root) {
      return;
    }
    const syncMedia = () => {
      root.querySelectorAll("audio, video").forEach((element) => {
        const media = element as HTMLMediaElement;
        media.muted = playbackMuted;
        media.volume = playbackMuted ? 0 : 1;
      });
    };
    syncMedia();
    const observer = new MutationObserver(() => syncMedia());
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [call, playbackMuted, spectatorDashboardLayout]);

  // IMPORTANT: keep this callback STABLE (empty deps).
  // If we put `call` into deps, every successful join recreates `disconnectStream`,
  // which then re-runs every effect that has `disconnectStream` in deps and the
  // STALE cleanup of those effects calls `disconnectStream()` again — which
  // unconditionally calls `setCall(null) / setClient(null)` and tears down the
  // observer right after a successful join. We read the latest call via callRef.
  const disconnectStream = useCallback(async () => {
    connectEpochRef.current += 1;
    if (participantWatchdogRef.current) {
      window.clearTimeout(participantWatchdogRef.current);
      participantWatchdogRef.current = null;
    }
    const activeCall = callRef.current;
    if (activeCall) {
      await activeCall.leave().catch(() => undefined);
    }
    // Do NOT call client.disconnectUser() on transient disconnects.
    // The observer client is a singleton via StreamVideoClient.getOrCreateInstance(...);
    // disconnecting the user here makes the next getOrCreateInstance return a stale,
    // disconnected client and triggers double-connectUser warnings.
    // Final cleanup happens only on full unmount via the dedicated effect below.
    callRef.current = null;
    setCall(null);
    setClient(null);
    setLocalUserId(null);
  }, []);

  useEffect(() => {
    if (!call || ended) {
      return;
    }
    let cancelled = false;
    const unregister = (call as unknown as {
      on?: (event: string, cb: (e: unknown) => void) => (() => void) | void;
    }).on?.("error", (event) => {
      try {
        if (cancelled) return;
        const reconnectStrategy = (event as { reconnectStrategy?: unknown }).reconnectStrategy;
        const error = (event as { error?: unknown }).error as { code?: unknown; message?: unknown } | undefined;
        const code =
          typeof error?.code === "string"
            ? error.code
            : typeof (event as { code?: unknown }).code === "string"
              ? ((event as { code?: string }).code as string)
              : null;
        const message =
          typeof error?.message === "string"
            ? error.message
            : typeof (event as { message?: unknown }).message === "string"
              ? ((event as { message?: string }).message as string)
              : "";
        const strategyRejoin =
          reconnectStrategy === 3 ||
          (typeof reconnectStrategy === "string" && reconnectStrategy.toLowerCase().includes("rejoin"));
        const ioTimeout = message.toLowerCase().includes("io timeout");
        const internalServerError = code === "INTERNAL_SERVER_ERROR";
        if (!strategyRejoin && !ioTimeout && !internalServerError) {
          return;
        }
        const now = Date.now();
        if (sfuRejoinInFlightRef.current) return;
        if (now - lastSfuRejoinAtMsRef.current < 15_000) return;
        lastSfuRejoinAtMsRef.current = now;
        sfuRejoinInFlightRef.current = true;
        console.warn("SFU error: rejoin required (io timeout)");
        void (async () => {
          try {
            await disconnectStream();
            // Allow auto-join to re-run after a forced SFU rejoin.
            autoJoinAttemptForRef.current = null;
            connectInFlightRef.current = false;
          } finally {
            sfuRejoinInFlightRef.current = false;
          }
        })();
      } catch {
        // ignore
      }
    });
    return () => {
      cancelled = true;
      if (typeof unregister === "function") {
        unregister();
      }
    };
  }, [call, disconnectStream, ended]);

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
      // Observer is view-only: never capture microphone for self-preview (leak risk).
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = selfCameraEnabled;
      });
      setSelfPreviewStream(stream);
    } catch (error) {
      // Self-preview is optional in observer mode; do not block session.
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("notallowed")) {
        setSelfPreviewError("Нет доступа к камере. Разрешите доступ в браузере.");
      } else if (message.toLowerCase().includes("notfound")) {
        setSelfPreviewError("Камера не найдена.");
      } else {
        setSelfPreviewError("Self-preview недоступен. Можно продолжать наблюдение без локального видео.");
      }
    }
  }, [selfCameraEnabled, selfPreviewStream, showSelfPreview]);

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
  }, [selfCameraEnabled, selfPreviewStream]);

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
    const explicitViewerKey = viewerKey?.trim();
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
  }, [meetingId, viewerKey]);

  const pipStorageKey = useMemo(() => {
    const id = meetingId?.trim() || "global";
    const layout = spectatorDashboardLayout ? "dashboard" : "card";
    return `nullxes:spectator:pip:${layout}:${id}`;
  }, [meetingId, spectatorDashboardLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(pipStorageKey);
    if (!raw) {
      setPipPinned(true);
      setPipPosition(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { pinned?: boolean; x?: number; y?: number };
      setPipPinned(parsed.pinned !== false);
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        setPipPosition({ x: parsed.x, y: parsed.y });
      } else {
        setPipPosition(null);
      }
    } catch {
      setPipPinned(true);
      setPipPosition(null);
    }
  }, [pipStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      pipStorageKey,
      JSON.stringify({
        pinned: pipPinned,
        x: pipPosition?.x,
        y: pipPosition?.y
      })
    );
  }, [pipPinned, pipPosition, pipStorageKey]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const pip = pipRef.current;
      const root = spectatorDashboardLayout ? splitPlaybackRootRef.current : streamViewportRef.current;
      if (!pip || !root) return;
      const rootRect = root.getBoundingClientRect();
      const next = clampPipPosition(
        { x: event.clientX - rootRect.left - drag.offsetX, y: event.clientY - rootRect.top - drag.offsetY },
        root,
        pip
      );
      setPipPosition(next);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [spectatorDashboardLayout]);

  const refreshObserverTicket = useCallback(async (): Promise<string | null> => {
    const token = joinToken?.trim();
    if (!token) {
      return null;
    }
    const response = await fetch(
      `/api/gateway/join/spectator/${encodeURIComponent(token)}/session-ticket`,
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
  }, [joinToken]);

  useEffect(() => {
    if (ended) {
      void disconnectStream();
      cleanupSelfPreview();
    }
  }, [cleanupSelfPreview, disconnectStream, ended]);

  useEffect(() => {
    if (!error) return;
    // If credentials/binding change after an error (e.g. observerTicket refreshed),
    // allow auto-join to retry without forcing user interaction.
    setError(null);
    setTransientStatus(null);
    autoJoinAttemptForRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, streamCallId, streamCallType, joinToken, observerTicket, viewerKind]);

  const startStream = useCallback(async () => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[observer-startStream-enter]", {
        epoch: connectEpochRef.current,
        hasClient: Boolean(clientRef.current),
        hasCall: Boolean(call),
        inFlight: connectInFlightRef.current
      });
    }
    if (ended) {
      return;
    }
    if (!meetingId) {
      return;
    }
    if (connectInFlightRef.current) {
      return;
    }
    if (!accessReady) {
      return;
    }
    const now = Date.now();
    if (reconnectLockUntilRef.current > now) {
      return;
    }
    reconnectLockUntilRef.current = now + OBSERVER_RECONNECT_LOCK_MS;
    // Sync lock: must be set BEFORE any await so a second mount in StrictMode
    // (or a fast re-render) cannot enter this function in parallel.
    connectInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setTransientStatus(null);
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
      let activeObserverTicket =
        observerAccessMode === "external_signed" ? observerTicket?.trim() || null : null;
      let refreshedTicketOnce = false;

      for (let attempt = 1; attempt <= OBSERVER_MAX_ATTEMPTS; attempt += 1) {
        let streamClient: StreamVideoClient | null = null;
        let streamCall: ReturnType<StreamVideoClient["call"]> | null = null;
        try {
          emitObserverAuditEvent("observer_join_attempt", {
            attempt,
            streamCallId: streamCallId ?? null,
            streamCallType: streamCallType ?? null
          });
          const tokenAbort = new AbortController();
          const abortTimer = setTimeout(() => tokenAbort.abort(), OBSERVER_TOKEN_TIMEOUT_MS);
          let response: Response;
          try {
            if (process.env.NODE_ENV !== "production") {
              console.info("[observer-token-request]", {
                observerAccessMode,
                hasJoinToken: Boolean(joinToken?.trim()),
                hasObserverTicket: Boolean(activeObserverTicket?.trim()),
                viewerKind,
                hasCallId: Boolean(streamCallId?.trim()),
                hasCallType: Boolean(streamCallType?.trim())
              });
            }
            response = await fetch("/api/stream/token", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              signal: tokenAbort.signal,
              body: JSON.stringify({
                role: "spectator",
                ...(viewerKind ? { viewerKind } : {}),
                meetingId,
                callId: streamCallId,
                callType: streamCallType,
                userName: participantName,
                ...(persistedViewerKey
                  ? { viewerKey: tabId ? `${persistedViewerKey}:${tabId}` : persistedViewerKey }
                  : {}),
                ...(observerAccessMode === "external_signed" && joinToken ? { joinToken } : {}),
                ...(observerAccessMode === "external_signed" && joinToken && activeObserverTicket
                  ? { observerTicket: activeObserverTicket }
                  : {})
              })
            });
          } finally {
            clearTimeout(abortTimer);
          }

          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as StreamTokenErrorPayload;
            if (process.env.NODE_ENV !== "production") {
              console.info("[observer-ticket-flow]", {
                attempt,
                responseStatus: response.status,
                responseCode: typeof payload.code === "string" ? payload.code : null,
                hasObserverTicket: Boolean(activeObserverTicket?.trim()),
                refreshedTicketOnce,
                observerAccessMode
              });
            }
            if (response.status === 409 && payload.code === "meeting.not_active") {
              throw new Error("meeting.not_active");
            }
            if (response.status === 409 && payload.code === "stream.binding_missing") {
              throw new Error("stream.binding_missing");
            }
            if (response.status === 503 && payload.code === "observer_role_unavailable") {
              throw new Error("observer_role_unavailable");
            }
            if (
              observerAccessMode === "external_signed" &&
              !refreshedTicketOnce &&
              isObserverTicketError(payload)
            ) {
              refreshedTicketOnce = true;
              if (observerAccessMode === "external_signed") {
                onObserverTicketInvalid?.();
              }
              const refreshed = await refreshObserverTicket();
              if (refreshed) {
                activeObserverTicket = refreshed;
                onObserverTicketRefresh?.(refreshed);
                throw new Error("observer.ticket.refreshed_retry");
              }
              onObserverTicketInvalid?.();
            }
            throw new Error(payload.message ?? "Failed to issue observer stream token");
          }

          const payload = (await response.json()) as StreamTokenResponse;
          // External tickets are consume-once; do not accept late responses for an old ticket.
          if (observerAccessMode === "external_signed") {
            const refTicket = currentTicketRef.current?.trim() || null;
            const usedTicket = activeObserverTicket?.trim() || null;
            if (usedTicket && refTicket && usedTicket !== refTicket) {
              throw new Error("observer.ticket.mismatch");
            }
          }
          // TODO(stream-auth): Stream рекомендует `tokenProvider` (auto-refresh) для long-lived клиентов.
          // Сейчас у нас одноразовый `observerTicket` (consume-once), поэтому нельзя просто
          // переиспользовать его в tokenProvider для повторного обновления токена.
          // Правильный будущий вариант: backend endpoint для observer refresh, который выдаёт новый Stream token
          // без повторного consume observerTicket (например, через серверную spectator-session + refresh).
          // См. avatar-stream-card: переопределяем axios-timeout Stream SDK
          // с дефолтных 5с на 60с, чтобы observer не падал посреди сессии
          // сообщением «timeout of 5000ms exceeded».
          // IMPORTANT: use getOrCreateInstance to avoid creating a second
          // StreamVideoClient for the same user (warning: "A StreamVideoClient
          // already exists ..."). When apiKey + token + user are passed,
          // the SDK connects automatically — do NOT call connectUser explicitly,
          // otherwise coordinator logs "Consecutive calls to connectUser".
          streamClient = StreamVideoClient.getOrCreateInstance({
            apiKey: payload.apiKey,
            token: payload.token,
            user: payload.user,
            options: { timeout: 60_000 }
          });
          streamCall = streamClient.call(payload.callType, payload.callId);
          await streamCall.camera.disable().catch(() => undefined);
          await streamCall.microphone.disable().catch(() => undefined);
          // Join timing: try twice with delay to reduce \"joined but empty\" races.
          let joined = false;
          for (let joinAttempt = 1; joinAttempt <= OBSERVER_JOIN_RETRY_ATTEMPTS; joinAttempt += 1) {
            try {
              await withTimeout(
                // Observer is read-only and must never create ghost calls.
                // Join only existing call created by candidate/HR flow.
                // Spectator does not publish mic/camera to SFU.
                // Do NOT pass `audio: false` here: in Stream SDK it may disable receiving
                // remote audio tracks, which breaks the requirement "spectator hears Stream audio".
                streamCall.join({ create: false, video: false } as Parameters<typeof streamCall.join>[0]),
                OBSERVER_JOIN_TIMEOUT_MS,
                "Observer stream join timeout"
              );
              joined = true;
              break;
            } catch (joinErr) {
              if (joinAttempt >= OBSERVER_JOIN_RETRY_ATTEMPTS) {
                throw joinErr;
              }
              await wait(OBSERVER_JOIN_RETRY_DELAY_MS);
            }
          }
          if (!joined) {
            throw new Error("observer.join.failed");
          }
          await streamCall.microphone.disable().catch(() => undefined);
          await streamCall.camera.disable().catch(() => undefined);
          // Best-effort: enable receiving remote audio if supported by SDK build.
          await (streamCall as unknown as { audio?: { enable?: () => Promise<unknown> } }).audio?.enable?.().catch(() => undefined);
          setConnectionPhase("connected");

          if (connectEpochRef.current !== epoch) {
            await streamCall.leave().catch(() => undefined);
            return;
          }
          clientRef.current = streamClient;
          callRef.current = streamCall;
          setClient(streamClient);
          setCall(streamCall);
          setLocalUserId(payload.user.id);
          setHasParticipants(null);
          setTransientStatus(null);
          emitObserverAuditEvent("observer_joined", {
            userId: payload.user.id,
            callId: payload.callId,
            callType: payload.callType
          });
          void ensureSelfPreview();

          // Watchdog: if still no participants after join, soft retry (leave+join).
          const joinedCall = streamCall;
          if (participantWatchdogRef.current) {
            window.clearTimeout(participantWatchdogRef.current);
            participantWatchdogRef.current = null;
          }
          const watchdogTimer = window.setTimeout(() => {
            try {
              if (connectEpochRef.current !== epoch) return;
              if (callRef.current !== joinedCall) return;
              const participantsMap = (joinedCall as unknown as { state?: { participants?: Map<string, unknown> } })
                .state?.participants;
              const participantsCount = participantsMap ? participantsMap.size : 0;
              const hasAudioTracks = Boolean(
                participantsMap &&
                  [...(participantsMap.values() as Iterable<unknown>)].some((p) => {
                    if (!p || typeof p !== "object") return false;
                    const tracks = (p as { publishedTracks?: unknown }).publishedTracks;
                    if (!tracks || typeof tracks !== "object") return false;
                    const record = tracks as Record<string, unknown>;
                    return Boolean(record.audio || record.audioTrack);
                  })
              );
              if (process.env.NODE_ENV !== "production") {
                console.log("[observer-join]", { participantsCount, hasAudioTracks });
              }
              if (participantsCount === 0) {
                console.warn("observer_no_participants_after_join");
              }
              if (!hasAudioTracks) {
                console.warn("observer_connected_but_no_audio_tracks");
              }
              if (participantsCount === 0) {
                void joinedCall
                  .leave()
                  .catch(() => undefined)
                  .then(() => wait(800))
                  .then(() =>
                    joinedCall.join({ create: false, video: false } as Parameters<typeof joinedCall.join>[0])
                  )
                  .catch(() => undefined);
              }
            } catch {
              // ignore
            }
          }, OBSERVER_PARTICIPANT_WATCHDOG_MS);
          participantWatchdogRef.current = watchdogTimer;
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error("Failed to start observer stream");
          await streamCall?.leave().catch(() => undefined);
          // Keep singleton client alive for retries (getOrCreateInstance reuses).
          const lower = lastError.message.toLowerCase();
          const transient =
            lower.includes("timeout") ||
            lower.includes("timed out") ||
            lower.includes("failed to fetch") ||
            lower.includes("network") ||
            lower.includes("abort") ||
            lower.includes("observer.ticket.refreshed_retry") ||
            lower.includes("observer.ticket.mismatch") ||
            lower.includes("meeting.not_active") ||
            lower.includes("stream.binding_missing") ||
            lower.includes("observer_role_unavailable") ||
            lower.includes("readonly role") ||
            lower.includes("observer readonly role") ||
            lower.includes("video") ||
            lower.includes("media") ||
            lower.includes("сессия не активна");
          if (!transient || attempt >= OBSERVER_MAX_ATTEMPTS) {
            if (lower.includes("meeting.not_active") || lower.includes("сессия не активна")) {
              throw new Error("Сессия еще запускается. Повторите подключение через 2-3 секунды.");
            }
            if (lower.includes("stream.binding_missing") && suppressErrorToasts) {
              // Internal dashboard: treat as waiting state, no hard failure toast.
              throw new Error("Ждём конфигурацию Stream call.");
            }
            throw lastError;
          }
          const baseBackoffMs = OBSERVER_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
          const cappedBackoffMs = Math.min(baseBackoffMs, 15_000);
          const jitterMs = Math.floor(Math.random() * 350);
          await wait(cappedBackoffMs + jitterMs);
        }
      }

      if (lastError) {
        throw lastError;
      }
    } catch (err) {
      if (connectEpochRef.current !== epoch) {
        return;
      }
      const msgRaw = err instanceof Error ? err.message : "Failed to start observer stream";
      const msg = normalizeObserverStreamError(msgRaw);
      if (isObserverTransientMessage(msg)) {
        // Transient failures must not block auto-join via `error` state.
        setError(null);
        setTransientStatus(
          msg.includes("observer_role_unavailable") ||
            msg.toLowerCase().includes("readonly role") ||
            msg.toLowerCase().includes("observer readonly role")
            ? "Подготавливаем режим наблюдателя…"
            : msg
        );
        setConnectionPhase(call ? "reconnecting" : "connecting");
        console.warn("observer transient state", msg);
        autoJoinAttemptForRef.current = null;
        return;
      }
      setTransientStatus(null);
      setError(msg);
      setConnectionPhase("failed");
      if (!suppressErrorToasts) {
        toast.error("Видео наблюдателя", { description: msg });
      }
      console.warn("observer join failed", msg);
      autoJoinAttemptForRef.current = null;
    } finally {
      connectInFlightRef.current = false;
      if (connectEpochRef.current === epoch) {
        setBusy(false);
      }
    }
  }, [
    accessReady,
    ended,
    ensureSelfPreview,
    observerAccessMode,
    streamCallId,
    streamCallType,
    meetingId,
    participantName,
    refreshObserverTicket,
    persistedViewerKey,
    joinToken,
    observerTicket,
    tabId,
    call,
    emitObserverAuditEvent,
    onObserverTicketInvalid,
    onObserverTicketRefresh,
    suppressErrorToasts,
    viewerKind
  ]);

  useEffect(() => {
    const autoJoinKey = `${meetingId ?? "no-meeting"}:${streamCallType ?? "no-type"}:${streamCallId ?? "no-call"}:${joinToken ?? ""}:${observerTicket ?? ""}`;
    if (process.env.NODE_ENV !== "production") {
      console.info("[observer-autojoin-state]", {
        canConnect,
        hasCall: Boolean(call),
        busy,
        hasError: Boolean(error),
        error,
        meetingId,
        hasStreamCallId: Boolean(streamCallId),
        hasStreamCallType: Boolean(streamCallType),
        viewerKind,
        observerAccessMode,
        hasJoinToken: Boolean(joinToken),
        hasObserverTicket: Boolean(observerTicket),
        autoJoinKey,
        lastAutoJoinKey: autoJoinAttemptForRef.current
      });
    }
    if (!canConnect || call || busy || error) return;
    if (autoJoinAttemptForRef.current === autoJoinKey) {
      return;
    }
    autoJoinAttemptForRef.current = autoJoinKey;
    void startStream();
  }, [busy, call, canConnect, error, joinToken, meetingId, observerTicket, observerAccessMode, startStream, streamCallId, streamCallType, viewerKind]);

  useEffect(() => {
    if (canConnect) {
      return;
    }
    void disconnectStream();
    noParticipantsReconnectCountRef.current = {};
  }, [canConnect, disconnectStream]);

  useEffect(() => {
    if (!canConnect || !call || hasParticipants !== false || busy) {
      return;
    }
    const reconnectKey = `${meetingId ?? "no-meeting"}:${streamCallType ?? "no-type"}:${streamCallId ?? "no-call"}`;
    const reconnectCount = noParticipantsReconnectCountRef.current[reconnectKey] ?? 0;
    if (reconnectCount >= OBSERVER_NO_PARTICIPANTS_RECONNECT_MAX) {
      return;
    }
    const timer = setTimeout(() => {
      const currentCount = noParticipantsReconnectCountRef.current[reconnectKey] ?? 0;
      if (currentCount >= OBSERVER_NO_PARTICIPANTS_RECONNECT_MAX) {
        return;
      }
      noParticipantsReconnectCountRef.current[reconnectKey] = currentCount + 1;
      emitObserverAuditEvent("observer_no_participants_retry", {
        reconnectKey,
        attempt: currentCount + 1,
        maxAttempts: OBSERVER_NO_PARTICIPANTS_RECONNECT_MAX
      });
      void disconnectStream().then(() => {
        // Allow controlled auto-rejoin attempts when Stream presence lags behind join.
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
    streamCallType,
    emitObserverAuditEvent
  ]);

  useEffect(() => {
    if (!call) {
      return;
    }
    void call.microphone.disable().catch(() => undefined);
  }, [call]);

  useEffect(() => {
    if (call && talkMode === "on") {
      onTalkModeChange?.("off");
    }
  }, [call, onTalkModeChange, talkMode]);

  useEffect(() => {
    if ((status === "joining" || status === "waiting_meeting") && talkMode === "on") {
      onTalkModeChange?.("off");
    }
  }, [onTalkModeChange, status, talkMode]);

  // Single unmount-only cleanup. disconnectStream and cleanupSelfPreview are stable
  // (empty deps), so deps array is intentionally empty: this effect must run its
  // teardown ONLY when the component unmounts, never when transient state changes.
  useEffect(
    () => () => {
      void disconnectStream();
      cleanupSelfPreview();
      const c = clientRef.current;
      if (c) {
        void c.disconnectUser().catch(() => undefined);
        clientRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const showJoinLoader = busy && visible;
  const showSingleFeedMode = focusCandidateOnly && status !== "no_participants";
  const toggleFullscreen = useCallback(() => {
    const root = spectatorDashboardLayout ? splitPlaybackRootRef.current : streamViewportRef.current;
    if (!root || typeof document === "undefined") {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void root.requestFullscreen?.().catch(() => undefined);
  }, [spectatorDashboardLayout]);

  const resolvedCandidateDisplayName = (candidateDisplayName?.trim() || "Кандидат").trim();

  const observerToolbar = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
        <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">{participantName}</p>
        <div className="flex items-center gap-2">
          <InterviewStatusBadge status={videoStatusView} />
          <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
            <span className="mr-1 text-emerald-600" aria-hidden>
              ●
            </span>
            {statusBadgeLabel}
          </Badge>
        </div>
      </div>

      {viewMode === "waiting" ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-700">
              {transientStatus
                ? "Подключаем наблюдателя…"
                : canConnect && busy
                  ? "Подключаем наблюдателя…"
                  : canConnect && !busy && !call
                    ? "Готово к подключению"
                    : waitingReason
                      ? "Ожидание"
                      : "Ожидание запуска"}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-600">
              {transientStatus || statusHint || waitingReason || "Видео подключится автоматически после старта интервью."}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {!call && canConnect ? (
              <Button
                type="button"
                className="h-9 min-h-9 rounded-full px-3 text-xs"
                onClick={() => {
                  setError(null);
                  setTransientStatus(null);
                  autoJoinAttemptForRef.current = null;
                  void startStream();
                }}
                disabled={busy}
                title={busy ? "Выполняется подключение" : "Подключить наблюдателя к активной сессии"}
              >
                <Video className="mr-1 h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Подключиться</span>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {viewMode === "ended" ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5" />
        </div>
      ) : null}

      {viewMode === "live" ? (
        <>
          {allowTalkToggle && visible ? <MicIndicator active={talkMode === "on" && Boolean(call)} /> : null}
          <div className="flex min-h-9 flex-wrap gap-1.5">
            {call ? (
              <>
                <Button
                  type="button"
                  variant={playbackMuted ? "secondary" : "outline"}
                  className="h-9 min-h-9 rounded-full px-3 text-xs focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  onClick={() => setPlaybackMuted((prev) => !prev)}
                  title={playbackMuted ? "Включить звук воспроизведения" : "Выключить звук воспроизведения"}
                >
                  {playbackMuted ? (
                    <VolumeX className="mr-1 h-4 w-4" aria-hidden />
                  ) : (
                    <Volume2 className="mr-1 h-4 w-4" aria-hidden />
                  )}
                  <span className="hidden sm:inline">Звук</span>
                </Button>
                {!spectatorDashboardLayout ? (
                  <>
                    <Button
                      type="button"
                      variant={showSingleFeedMode ? "secondary" : "outline"}
                      className="h-9 min-h-9 rounded-full px-3 text-xs focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                      onClick={() => setFocusCandidateOnly((prev) => !prev)}
                      title="Переключить раскладку участников"
                    >
                      {showSingleFeedMode ? (
                        <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
                      ) : (
                        <Maximize2 className="mr-1 h-4 w-4" aria-hidden />
                      )}
                      <span className="hidden sm:inline">{showSingleFeedMode ? "Все" : "Фокус"}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 min-h-9 rounded-full px-3 text-xs focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                      onClick={toggleFullscreen}
                      title="Открыть полноэкранный режим"
                    >
                      <Maximize2 className="mr-1 h-4 w-4" aria-hidden />
                      <span className="hidden sm:inline">Экран</span>
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 min-h-9 rounded-full px-3 text-xs focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                    onClick={toggleFullscreen}
                    title="Полноэкранный режим (кандидат + HR)"
                  >
                    <Maximize2 className="mr-1 h-4 w-4" aria-hidden />
                    <span className="hidden sm:inline">Экран</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 min-h-9 rounded-full px-3 text-xs focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  onClick={() => {
                    void disconnectStream().then(() => {
                      autoJoinAttemptForRef.current = null;
                    });
                  }}
                  disabled={busy || ended}
                  title="Переподключиться"
                  aria-label="Переподключиться"
                >
                  <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">Reconnect</span>
                </Button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );

  const selfPreviewPip = showSelfPreview ? (
    <div
      ref={pipRef}
      style={pipPosition ? { left: `${pipPosition.x}px`, top: `${pipPosition.y}px` } : undefined}
      className={cn(
        "z-20 w-44 rounded-xl border border-white/40 bg-slate-900/75 p-2 shadow-lg backdrop-blur",
        pipPosition ? "absolute" : spectatorDashboardLayout ? "absolute bottom-3 right-3" : "absolute right-3 top-3"
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center justify-between gap-2 rounded-md px-1",
          pipPinned ? "cursor-default" : "cursor-grab active:cursor-grabbing"
        )}
        onPointerDown={(event) => {
          if (pipPinned) return;
          const pip = pipRef.current;
          const root = spectatorDashboardLayout ? splitPlaybackRootRef.current : streamViewportRef.current;
          if (!pip || !root) return;
          const pipRect = pip.getBoundingClientRect();
          dragStateRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - pipRect.left,
            offsetY: event.clientY - pipRect.top
          };
        }}
      >
        <p className="text-center text-[10px] font-medium uppercase tracking-wide text-slate-400">
          Наблюдатель
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            className="h-6 rounded-full px-2 text-[10px] text-slate-200 hover:bg-slate-700/70"
            onClick={() => setPipPinned((prev) => !prev)}
            title={pipPinned ? "Открепить для перетаскивания" : "Закрепить текущую позицию"}
          >
            {pipPinned ? "Открепить" : "Закрепить"}
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg bg-black">
        {selfPreviewStream && selfCameraEnabled ? (
          <video ref={selfPreviewVideoRef} className="h-24 w-full object-cover" muted playsInline autoPlay />
        ) : (
          <div className="flex h-24 w-full items-center justify-center text-xs text-slate-300">Камера выключена</div>
        )}
      </div>
      <p className="mt-2 text-center text-[10px] leading-snug text-slate-300">Локальный preview · не транслируется</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant={selfCameraEnabled ? "default" : "secondary"}
          className="h-9 rounded-full px-3 text-xs"
          disabled={!selfPreviewStream}
          onClick={() => setSelfCameraEnabled((prev) => !prev)}
          title={selfCameraEnabled ? "Выключить камеру" : "Включить камеру"}
        >
          {selfCameraEnabled ? <Video className="mr-1 h-3.5 w-3.5" /> : <VideoOff className="mr-1 h-3.5 w-3.5" />}
          {selfCameraEnabled ? "Камера: вкл" : "Камера: выкл"}
        </Button>
        {selfPreviewError ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-full px-3 text-[11px]"
            onClick={() => void ensureSelfPreview()}
          >
            Повторить доступ
          </Button>
        ) : null}
      </div>
      {selfPreviewError ? (
        <p className="mt-2 rounded-lg bg-rose-100/90 px-2 py-1 text-[11px] leading-snug text-rose-700">{selfPreviewError}</p>
      ) : null}
    </div>
  ) : null;

  if (spectatorDashboardLayout) {
    return (
      <div className="grid w-full min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div
          ref={splitPlaybackRootRef}
          className={cn(
            "relative w-full min-w-0 rounded-2xl border border-white/40 bg-[#d9dee7]/40 p-2 shadow-sm",
            ended && "pointer-events-none opacity-70"
          )}
        >
          {busy && visible ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[#dfe4ec]/80 backdrop-blur-[1px]">
              <Loader2 className="h-8 w-8 animate-spin text-slate-600" aria-hidden />
            </div>
          ) : null}

          {!visible && allowVisibilityToggle ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 px-4 py-12 text-center">
              <p className="text-sm font-medium text-slate-700">{videoStatusView.label}</p>
              <p className="text-xs text-slate-600">Включите видео, чтобы видеть кандидата и HR</p>
            </div>
          ) : client && call && localUserId ? (
            <div className="relative min-h-[420px] w-full lg:min-h-[440px]">
              <StreamVideo client={client}>
                <StreamTheme>
                  <StreamCall call={call}>
                    <ObserverSplitDashboard
                      localUserId={localUserId}
                      candidateDisplayName={resolvedCandidateDisplayName}
                      agentAvatarImageUrl={agentAvatarImageUrl}
                      onParticipantsDetected={setHasParticipants}
                      candidateVideoContainerRef={candidateVideoContainerRef}
                    />
                  </StreamCall>
                </StreamTheme>
              </StreamVideo>
            </div>
          ) : (
            <div className="relative grid min-h-[280px] w-full min-w-0 grid-cols-1 gap-4 p-1 sm:min-h-[360px] md:grid-cols-2 md:min-h-[400px] lg:min-h-[420px]">
              <StreamParticipantShell
                title="Кандидат"
                videoClassName={cn(!call && "bg-slate-300/70", ended && "pointer-events-none opacity-70")}
                footer={
                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
                    <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">
                      {resolvedCandidateDisplayName}
                    </p>
                    <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                      <span className="mr-1 text-slate-500" aria-hidden>
                        ●
                      </span>
                      {statusBadgeLabel}
                    </Badge>
                  </div>
                }
              >
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  {showJoinLoader ? <Loader2 className="h-7 w-7 shrink-0 animate-spin text-slate-600" aria-hidden /> : null}
                  <VideoOff className="h-8 w-8 shrink-0 text-slate-600" strokeWidth={1.75} aria-hidden />
                  <p className="text-sm font-medium text-slate-700">{videoStatusView.label}</p>
                  <p className="max-w-[240px] text-xs text-slate-600">{statusHint}</p>
                </div>
              </StreamParticipantShell>
              <StreamParticipantShell
                title="HR аватар"
                videoClassName={cn(!call && "bg-slate-300/70", ended && "pointer-events-none opacity-70")}
                footer={
                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
                    <p className="min-h-5 min-w-0 flex-1 truncate text-sm font-medium leading-snug">HR ассистент</p>
                    <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
                      <span className="mr-1 text-slate-500" aria-hidden>
                        ●
                      </span>
                      {statusBadgeLabel}
                    </Badge>
                  </div>
                }
              >
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  {showJoinLoader ? <Loader2 className="h-7 w-7 shrink-0 animate-spin text-slate-600" aria-hidden /> : null}
                  <VideoOff className="h-8 w-8 shrink-0 text-slate-600" strokeWidth={1.75} aria-hidden />
                  <p className="text-sm font-medium text-slate-700">{videoStatusView.label}</p>
                  <p className="max-w-[240px] text-xs text-slate-600">{statusHint}</p>
                </div>
              </StreamParticipantShell>
            </div>
          )}
        </div>

        <aside className={cn("flex min-w-0 flex-col gap-3", ended && "pointer-events-none opacity-70")}>
          <div className="rounded-2xl border-0 bg-[#d9dee7] p-3 shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
            <p className="text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">Наблюдатель</p>
            <div className="mt-2">{observerToolbar}</div>
          </div>

          {showSelfPreview ? (
            <div className="rounded-2xl border border-white/50 bg-white/55 p-3 shadow-sm">
              <p className="text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Self-preview (локально)
              </p>
              <div className="mt-2 overflow-hidden rounded-xl bg-black">
                {selfPreviewStream && selfCameraEnabled ? (
                  <video ref={selfPreviewVideoRef} className="h-32 w-full object-cover" muted playsInline autoPlay />
                ) : (
                  <div className="flex h-32 w-full items-center justify-center text-xs text-slate-300">Камера выключена</div>
                )}
              </div>
              <p className="mt-2 text-center text-[10px] leading-snug text-slate-500">Не транслируется в звонок</p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant={selfCameraEnabled ? "default" : "secondary"}
                  className="h-9 rounded-full px-3 text-xs"
                  disabled={!selfPreviewStream}
                  onClick={() => setSelfCameraEnabled((prev) => !prev)}
                  title={selfCameraEnabled ? "Выключить камеру" : "Включить камеру"}
                >
                  {selfCameraEnabled ? <Video className="mr-1 h-3.5 w-3.5" /> : <VideoOff className="mr-1 h-3.5 w-3.5" />}
                  {selfCameraEnabled ? "Камера: вкл" : "Камера: выкл"}
                </Button>
                {selfPreviewError ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-full px-3 text-[11px]"
                    onClick={() => void ensureSelfPreview()}
                  >
                    Повторить доступ
                  </Button>
                ) : null}
              </div>
              {selfPreviewError ? (
                <p className="mt-2 rounded-lg bg-rose-100/90 px-2 py-1 text-[11px] leading-snug text-rose-700">{selfPreviewError}</p>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        </aside>
      </div>
    );
  }

  return (
    <StreamParticipantShell
      title={title}
      videoRef={streamViewportRef}
      videoClassName={cn(
        (!visible || !client || !call) && "bg-slate-300/70",
        ended && "pointer-events-none opacity-70"
      )}
      footer={observerToolbar}
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
                  agentAvatarImageUrl={agentAvatarImageUrl}
                  onParticipantsDetected={setHasParticipants}
                  sessionMirrorLayout={showSingleFeedMode ? false : sessionMirrorLayout}
                  candidateVideoContainerRef={candidateVideoContainerRef}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
          {selfPreviewPip}
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
