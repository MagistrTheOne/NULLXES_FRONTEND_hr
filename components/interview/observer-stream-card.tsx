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
  BellOff,
  Bookmark,
  GripHorizontal,
  Headphones,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Pin,
  PinOff,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
  VolumeX
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { InterviewStatusBadge } from "@/components/interview/interview-status-badge";
import { MicIndicator } from "@/components/interview/mic-indicator";
import { ObserverBookmarkPanel } from "@/components/interview/observer-bookmark-panel";
import { ObserverPresencePopover } from "@/components/interview/observer-presence-popover";
import { issueRuntimeCommand } from "@/lib/api";
import { mapVideoStatus, type VideoConnectionState } from "@/lib/interview-status";
import type { SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";
import { useObserverBookmarks, type ObserverBookmarkSpeaker } from "@/hooks/use-observer-bookmarks";
import { usePresenceLog } from "@/hooks/use-presence-log";
import { useSilenceDetector } from "@/hooks/use-silence-detector";

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
const OBSERVER_NO_PARTICIPANTS_GRACE_MS = 7_000;
const OBSERVER_NO_PARTICIPANTS_RECONNECT_MAX = 3;

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
  onParticipantsDetected?: (hasParticipants: boolean) => void;
  sessionMirrorLayout?: boolean;
  audioOnly?: boolean;
  candidateVideoContainerRef?: { current: HTMLDivElement | null };
};

/** Две колонки как у кандидата: кандидат | HR (внутри одного StreamCall). */
type ObserverSplitDashboardProps = {
  localUserId: string;
  candidateDisplayName: string;
  onParticipantsDetected?: (hasParticipants: boolean) => void;
  audioOnly?: boolean;
  candidateVideoContainerRef?: { current: HTMLDivElement | null };
};

function ObserverSplitDashboard({
  localUserId,
  candidateDisplayName,
  onParticipantsDetected,
  audioOnly = false,
  candidateVideoContainerRef
}: ObserverSplitDashboardProps) {
  const { useCallCallingState, useParticipants } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();

  const remoteCount = useMemo(
    () => participants.filter((p) => p.userId !== localUserId).length,
    [localUserId, participants]
  );

  useEffect(() => {
    onParticipantsDetected?.(remoteCount > 0);
  }, [onParticipantsDetected, remoteCount]);

  const { candidateParticipant, agentParticipant } = useMemo(() => {
    const candidate =
      participants.find((participant) => participant.userId?.startsWith("candidate-")) ?? null;
    const agent =
      participants.find((participant) => participant.userId?.startsWith("agent-")) ??
      participants.find((participant) => participant.userId?.startsWith("agent_")) ??
      null;
    return { candidateParticipant: candidate, agentParticipant: agent };
  }, [participants]);

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
            audioOnly ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
                <p>{candidateDisplayName}</p>
                <Badge variant="secondary">{candidateParticipant.isSpeaking ? "Говорит" : "Слушает"}</Badge>
              </div>
            ) : (
              <ParticipantView participant={candidateParticipant} trackType="videoTrack" ParticipantViewUI={() => null} />
            )
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
          audioOnly ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
              <p>HR ассистент</p>
              <Badge variant="secondary">{agentParticipant.isSpeaking ? "Говорит" : "Слушает"}</Badge>
            </div>
          ) : (
            <ParticipantView participant={agentParticipant} trackType="videoTrack" ParticipantViewUI={() => null} />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание HR аватара</div>
        )}
      </StreamParticipantShell>
    </div>
  );
}

function ObserverCallBody({
  localUserId,
  onParticipantsDetected,
  sessionMirrorLayout = false,
  audioOnly = false,
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
              audioOnly ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
                  <p>Кандидат</p>
                  <Badge variant="secondary">{candidateParticipant.isSpeaking ? "Говорит" : "Слушает"}</Badge>
                </div>
              ) : (
                <ParticipantView participant={candidateParticipant} trackType="videoTrack" ParticipantViewUI={() => null} />
              )
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
            audioOnly ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-600">
                <p>HR ассистент</p>
                <Badge variant="secondary">{agentParticipant.isSpeaking ? "Говорит" : "Слушает"}</Badge>
              </div>
            ) : (
              <ParticipantView participant={agentParticipant} trackType="videoTrack" ParticipantViewUI={() => null} />
            )
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
            audioOnly ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-300">
                <p>Кандидат</p>
                <Badge variant="secondary">{candidate.isSpeaking ? "Говорит" : "Слушает"}</Badge>
              </div>
            ) : (
              <ParticipantView participant={candidate} trackType="videoTrack" />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание кандидата</div>
          )}
        </div>
      </div>
      <div className="grid gap-2 md:grid-rows-2">
        <div className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
          {avatar ? (
            audioOnly ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-300">
                <p>HR ассистент</p>
                <Badge variant="secondary">{avatar.isSpeaking ? "Говорит" : "Слушает"}</Badge>
              </div>
            ) : (
              <ParticipantView participant={avatar} trackType="videoTrack" />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Ожидание HR аватара</div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1">
          {extra.map((participant) => (
            <div key={participant.sessionId} className="overflow-hidden rounded-lg border border-white/20 bg-slate-900/50">
              {audioOnly ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-slate-300">
                  <p>{participant.name || participant.userId || "Участник"}</p>
                  <Badge variant="secondary">{participant.isSpeaking ? "Говорит" : "Слушает"}</Badge>
                </div>
              ) : (
                <ParticipantView participant={participant} trackType="videoTrack" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type ObserverAnalyticsBridgeProps = {
  localUserId: string;
  enabled: boolean;
  onJoinedWithRemote: () => void;
  onPresenceEvent: (text: string) => void;
  onSpeakerChange: (speaker: ObserverBookmarkSpeaker) => void;
  onDominantSpeakerPresent: (present: boolean) => void;
};

function ObserverAnalyticsBridge({
  localUserId,
  enabled,
  onJoinedWithRemote,
  onPresenceEvent,
  onSpeakerChange,
  onDominantSpeakerPresent
}: ObserverAnalyticsBridgeProps) {
  const { useCallCallingState, useParticipants, useDominantSpeaker } = useCallStateHooks();
  const state = useCallCallingState();
  const participants = useParticipants();
  const dominantSpeaker = useDominantSpeaker();
  const prevParticipantIdsRef = useRef<Set<string>>(new Set());
  const prevSpeakerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const remoteParticipants = participants.filter((p) => p.userId && p.userId !== localUserId);
    if (state === CallingState.JOINED && remoteParticipants.length > 0) {
      onJoinedWithRemote();
    }
  }, [enabled, localUserId, onJoinedWithRemote, participants, state]);

  useEffect(() => {
    if (!enabled) return;
    const current = new Set(
      participants
        .filter((item) => item.userId && item.userId !== localUserId)
        .map((item) => item.userId as string)
    );
    const prev = prevParticipantIdsRef.current;
    const joined = [...current].filter((id) => !prev.has(id));
    const left = [...prev].filter((id) => !current.has(id));

    joined.forEach((id) => {
      if (id.startsWith("candidate-")) onPresenceEvent("Кандидат подключился");
      else if (id.startsWith("agent-") || id.startsWith("agent_")) onPresenceEvent("HR агент подключился");
    });
    left.forEach((id) => {
      if (id.startsWith("candidate-")) onPresenceEvent("Кандидат отключился");
      else if (id.startsWith("agent-") || id.startsWith("agent_")) onPresenceEvent("HR агент отключился");
    });
    prevParticipantIdsRef.current = current;
  }, [enabled, localUserId, onPresenceEvent, participants]);

  useEffect(() => {
    if (!enabled || state !== CallingState.JOINED) {
      onDominantSpeakerPresent(false);
      onSpeakerChange("unknown");
      prevSpeakerRef.current = null;
      return;
    }
    const hasDominant = Boolean(dominantSpeaker?.userId && dominantSpeaker.userId !== localUserId);
    onDominantSpeakerPresent(hasDominant);
    if (!hasDominant) return;
    const speakerId = dominantSpeaker?.userId ?? "";
    const speaker: ObserverBookmarkSpeaker =
      speakerId.startsWith("candidate-")
        ? "candidate"
        : speakerId.startsWith("agent-") || speakerId.startsWith("agent_")
          ? "agent"
          : "unknown";
    onSpeakerChange(speaker);
    if (prevSpeakerRef.current !== speakerId) {
      const label = speaker === "candidate" ? "Кандидат" : speaker === "agent" ? "HR агент" : "Неизвестно";
      onPresenceEvent(`Активный спикер: ${label}`);
      prevSpeakerRef.current = speakerId;
    }
  }, [dominantSpeaker, enabled, localUserId, onDominantSpeakerPresent, onPresenceEvent, onSpeakerChange, state]);

  return null;
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
  waitingReason = null,
  spectatorDashboardLayout = false,
  candidateDisplayName = null
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
  const pipRef = useRef<HTMLDivElement | null>(null);
  const candidateVideoContainerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [pipPosition, setPipPosition] = useState<PipPosition | null>(null);
  const [pipPinned, setPipPinned] = useState(true);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [currentSpeaker, setCurrentSpeaker] = useState<ObserverBookmarkSpeaker>("unknown");
  const [dominantSpeakerPresent, setDominantSpeakerPresent] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(true);

  const ended = Boolean(sessionEnded) || uiState === "completed";
  const canConnect =
    enabled &&
    visible &&
    Boolean(meetingId) &&
    Boolean(streamCallId?.trim()) &&
    Boolean(streamCallType?.trim()) &&
    !ended;
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
    if (call && connectionPhase === "connected") {
      if (status === "no_participants") {
        return "Подключено. Ждём участников сессии (кандидат/HR).";
      }
      return "Наблюдатель подключен к активной сессии.";
    }
    if (call) {
      return "Подключение к звонку…";
    }
    return waitingReason ?? "Ожидание запуска. Подключение выполнится автоматически, когда сессия будет доступна.";
  }, [busy, call, connectionPhase, enabled, ended, error, meetingId, status, streamCallId, streamCallType, waitingReason]);

  const statusBadgeLabel = useMemo(() => {
    if (ended) return "Завершено";
    if (error) return "Ошибка видео";
    if (busy || connectionPhase === "reconnecting") return "Подключаемся…";
    if (status === "no_participants") return "Подключено, ждём";
    if (call) return "В эфире";
    if (!enabled || !meetingId) return "Ожидание запуска";
    return "Не в эфире";
  }, [busy, call, connectionPhase, enabled, ended, error, meetingId, status]);

  const silenceEnabledStorageKey = useMemo(
    () => `nullxes:spectator:silence-enabled:${meetingId ?? "global"}`,
    [meetingId]
  );
  const audioOnlyStorageKey = useMemo(
    () => `nullxes:spectator:audio-only:${meetingId ?? "global"}`,
    [meetingId]
  );
  const [silenceIndicatorEnabled, setSilenceIndicatorEnabled] = useState(true);
  const [audioOnlyMode, setAudioOnlyMode] = useState(false);
  const { events: presenceEvents, pushEvent } = usePresenceLog({ sessionStartedAt });

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSilenceIndicatorEnabled(window.localStorage.getItem(silenceEnabledStorageKey) !== "0");
    setAudioOnlyMode(window.localStorage.getItem(audioOnlyStorageKey) === "1");
  }, [audioOnlyStorageKey, silenceEnabledStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(silenceEnabledStorageKey, silenceIndicatorEnabled ? "1" : "0");
  }, [silenceEnabledStorageKey, silenceIndicatorEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(audioOnlyStorageKey, audioOnlyMode ? "1" : "0");
  }, [audioOnlyMode, audioOnlyStorageKey]);

  const { silenceMs, isSilent } = useSilenceDetector({
    enabled: silenceIndicatorEnabled && visible,
    joined: Boolean(call),
    hasDominantSpeaker: dominantSpeakerPresent
  });

  const bookmarks = useObserverBookmarks({
    meetingId,
    enabled: Boolean(visible && call && localUserId),
    sessionStartedAt,
    // Берём video кандидата из целевого контейнера; fallback нужен для legacy-раскладки.
    resolveCandidateVideoElement: () =>
      candidateVideoContainerRef.current?.querySelector("video") ??
      (streamViewportRef.current?.querySelector("video") as HTMLVideoElement | null),
    resolveSpeaker: () => currentSpeaker
  });

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  useEffect(() => {
    if (!call || ended) {
      setSessionStartedAt(null);
      setDominantSpeakerPresent(false);
      setCurrentSpeaker("unknown");
    }
  }, [call, ended]);

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
      // Observer is view-only: never capture microphone for self-preview (leak risk).
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
          emitObserverAuditEvent("observer_join_attempt", {
            attempt,
            streamCallId: streamCallId ?? null,
            streamCallType: streamCallType ?? null
          });
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
            // audio: false — never publish microphone to SFU (candidate must not hear observer).
            // JoinCallData in react-sdk typings omits `audio`; coordinator accepts it (@stream-io/video-client).
            streamCall.join({ create: false, video: false, audio: false } as Parameters<typeof streamCall.join>[0]),
            OBSERVER_JOIN_TIMEOUT_MS,
            "Observer stream join timeout"
          );
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
          emitObserverAuditEvent("observer_joined", {
            userId: payload.user.id,
            callId: payload.callId,
            callType: payload.callType
          });
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
      const msgRaw = err instanceof Error ? err.message : "Failed to start observer stream";
      const msg = normalizeObserverStreamError(msgRaw);
      setError(msg);
      setConnectionPhase("failed");
      toast.error("Видео наблюдателя", { description: msg });
      pushEvent(`Ошибка подключения наблюдателя: ${msg}`);
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
    call,
    pushEvent,
    emitObserverAuditEvent
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

  useEffect(
    () => () => {
      void disconnectStream();
      cleanupSelfPreview();
    },
    [cleanupSelfPreview, disconnectStream]
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
          {silenceIndicatorEnabled && isSilent ? (
            <Badge className="animate-pulse bg-amber-100 text-amber-900">Тишина {Math.floor(silenceMs / 1000)}с</Badge>
          ) : null}
          <InterviewStatusBadge status={videoStatusView} />
          <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-xs font-normal">
            <span className="mr-1 text-emerald-600" aria-hidden>
              ●
            </span>
            {statusBadgeLabel}
          </Badge>
        </div>
      </div>
      {allowTalkToggle && visible ? <MicIndicator active={talkMode === "on" && Boolean(call)} /> : null}
      <div className="flex min-h-10 flex-wrap gap-2">
        <Button
          type="button"
          variant={audioOnlyMode ? "secondary" : "outline"}
          className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          onClick={() => setAudioOnlyMode((prev) => !prev)}
          title="Скрыть видео и оставить только аудио дорожки"
        >
          <Headphones className="mr-2 h-4 w-4" />
          Только аудио
        </Button>
        <Button
          type="button"
          variant={silenceIndicatorEnabled ? "outline" : "secondary"}
          className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          onClick={() => setSilenceIndicatorEnabled((prev) => !prev)}
          title="Вкл/выкл индикатор длительной тишины"
        >
          <BellOff className="mr-2 h-4 w-4" />
          Тишина
        </Button>
        <ObserverPresencePopover events={presenceEvents} />
        <Button
          type="button"
          variant={bookmarksOpen ? "secondary" : "outline"}
          className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          onClick={() => setBookmarksOpen((prev) => !prev)}
          title="Открыть таймлайн заметок (M/N/S)"
        >
          <Bookmark className="mr-2 h-4 w-4" />
          Метки
        </Button>
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
        {call ? (
          <>
            <Button
              type="button"
              variant={playbackMuted ? "secondary" : "outline"}
              className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
              onClick={() => setPlaybackMuted((prev) => !prev)}
              title={playbackMuted ? "Включить звук воспроизведения" : "Выключить звук воспроизведения"}
            >
              {playbackMuted ? <VolumeX className="mr-2 h-4 w-4" /> : <Volume2 className="mr-2 h-4 w-4" />}
              {playbackMuted ? "Звук: выкл" : "Звук: вкл"}
            </Button>
            {!spectatorDashboardLayout ? (
              <>
                <Button
                  type="button"
                  variant={showSingleFeedMode ? "secondary" : "outline"}
                  className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  onClick={() => setFocusCandidateOnly((prev) => !prev)}
                  title="Переключить раскладку участников"
                >
                  {showSingleFeedMode ? <RotateCcw className="mr-2 h-4 w-4" /> : <Maximize2 className="mr-2 h-4 w-4" />}
                  {showSingleFeedMode ? "Показать всех" : "Фокус на кандидате"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  onClick={toggleFullscreen}
                  title="Открыть полноэкранный режим"
                >
                  <Maximize2 className="mr-2 h-4 w-4" />
                  Fullscreen
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                onClick={toggleFullscreen}
                title="Полноэкранный режим (кандидат + HR)"
              >
                <Maximize2 className="mr-2 h-4 w-4" />
                Fullscreen
              </Button>
            )}
          </>
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
        {call ? (
          <Button
            type="button"
            variant="outline"
            className="h-10 min-h-10 rounded-full px-4 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
            onClick={() => {
              void disconnectStream().then(() => {
                autoJoinAttemptForRef.current = null;
              });
            }}
            disabled={busy || ended}
          >
            Reconnect
          </Button>
        ) : null}
      </div>
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
          <GripHorizontal className="h-3.5 w-3.5 text-slate-400" />
          <Button
            type="button"
            variant="ghost"
            className="h-6 rounded-full px-2 text-[10px] text-slate-200 hover:bg-slate-700/70"
            onClick={() => setPipPinned((prev) => !prev)}
            title={pipPinned ? "Открепить для перетаскивания" : "Закрепить текущую позицию"}
          >
            {pipPinned ? <PinOff className="mr-1 h-3 w-3" /> : <Pin className="mr-1 h-3 w-3" />}
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
        <Button
          type="button"
          variant={selfMicEnabled ? "default" : "secondary"}
          className="h-9 rounded-full px-3 text-xs"
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
      <div className="flex w-full min-w-0 flex-col gap-3">
        <div className="text-center">
          <h2 className="text-xl font-medium leading-tight text-slate-600 sm:text-2xl">Наблюдатель</h2>
          <p className="mt-1 text-xs text-slate-500 sm:text-sm">
            Тот же вид, что у кандидата: кандидат и HR. Управление сессией HR недоступно.
          </p>
        </div>

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
              <p className="text-xs text-slate-600">Включите видео, чтобы видеть кандидата и агента</p>
            </div>
          ) : client && call && localUserId ? (
            <div className="relative min-h-[420px] w-full lg:min-h-[440px]">
              <StreamVideo client={client}>
                <StreamTheme>
                  <StreamCall call={call}>
                    <ObserverAnalyticsBridge
                      localUserId={localUserId}
                      enabled={Boolean(visible && call && localUserId)}
                      onJoinedWithRemote={() => setSessionStartedAt((prev) => prev ?? Date.now())}
                      onPresenceEvent={pushEvent}
                      onSpeakerChange={setCurrentSpeaker}
                      onDominantSpeakerPresent={setDominantSpeakerPresent}
                    />
                    <ObserverSplitDashboard
                      localUserId={localUserId}
                      candidateDisplayName={resolvedCandidateDisplayName}
                      onParticipantsDetected={setHasParticipants}
                      audioOnly={audioOnlyMode}
                      candidateVideoContainerRef={candidateVideoContainerRef}
                    />
                  </StreamCall>
                </StreamTheme>
              </StreamVideo>
              {visible && call && localUserId ? (
                <div className="absolute bottom-3 left-3 z-20 w-[min(360px,calc(100%-1.5rem))]">
                  <ObserverBookmarkPanel
                    open={bookmarksOpen}
                    onOpenChange={setBookmarksOpen}
                    bookmarks={bookmarks.bookmarks}
                    loading={bookmarks.loading}
                    inputFocusNonce={bookmarks.inputFocusNonce}
                    onCreateBookmark={bookmarks.createBookmark}
                    onDeleteBookmark={bookmarks.deleteBookmark}
                    onUpdateBookmark={bookmarks.updateBookmark}
                    onExport={bookmarks.exportBookmarks}
                  />
                </div>
              ) : null}
              {selfPreviewPip}
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
              {selfPreviewPip}
            </div>
          )}
        </div>

        <div className="rounded-2xl border-0 bg-[#d9dee7] p-3 shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
          {observerToolbar}
        </div>
        {error ? <p className="w-full rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
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
                <ObserverAnalyticsBridge
                  localUserId={localUserId}
                  enabled={Boolean(visible && call && localUserId)}
                  onJoinedWithRemote={() => setSessionStartedAt((prev) => prev ?? Date.now())}
                  onPresenceEvent={pushEvent}
                  onSpeakerChange={setCurrentSpeaker}
                  onDominantSpeakerPresent={setDominantSpeakerPresent}
                />
                <ObserverCallBody
                  localUserId={localUserId}
                  onParticipantsDetected={setHasParticipants}
                  sessionMirrorLayout={showSingleFeedMode ? false : sessionMirrorLayout}
                  audioOnly={audioOnlyMode}
                  candidateVideoContainerRef={candidateVideoContainerRef}
                />
              </StreamCall>
            </StreamTheme>
          </StreamVideo>
          {visible && call && localUserId ? (
            <div className="absolute bottom-3 left-3 z-20 w-[min(360px,calc(100%-1.5rem))]">
              <ObserverBookmarkPanel
                open={bookmarksOpen}
                onOpenChange={setBookmarksOpen}
                bookmarks={bookmarks.bookmarks}
                loading={bookmarks.loading}
                inputFocusNonce={bookmarks.inputFocusNonce}
                onCreateBookmark={bookmarks.createBookmark}
                onDeleteBookmark={bookmarks.deleteBookmark}
                onUpdateBookmark={bookmarks.updateBookmark}
                onExport={bookmarks.exportBookmarks}
              />
            </div>
          ) : null}
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
