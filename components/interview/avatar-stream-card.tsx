"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CallControls, CallingState, ParticipantView, StreamCall, StreamTheme, StreamVideo, StreamVideoClient, useCallStateHooks } from "@stream-io/video-react-sdk";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";
import { Badge } from "@/components/ui/badge";
import type { SessionUIState } from "@/lib/session-ui-state";
import { cn } from "@/lib/utils";

/**
 * Временный placeholder для HR-аватара пока avatar-pod выключен / не успел
 * опубликовать видео в Stream. Файл лежит в /public/anna.jpg и отдаётся
 * Next'ом как статический asset. Убрать / заменить на live video, как
 * только RunPod avatar service начнёт публиковать `agent_<sessionId>`.
 */
const AVATAR_PLACEHOLDER_SRC = "/anna.jpg";

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
    // HARD WHITELIST: показываем в HR-avatar tile ТОЛЬКО participants, чей
    // userId относится к avatar-поду:
    //   - `agent_<sessionId>` (production shape из RunPod avatar service)
    //   - `agent-<meetingId>`  (legacy simulation)
    //
    // Никаких fallback'ов на «любого не-viewer participant» — раньше это
    // приводило к тому, что когда avatar-pod офф, HR-avatar tile подхватывал
    // видеопоток кандидата (он единственный не-viewer в комнате) и в двух
    // колонках отображалось одно и то же лицо. Если pod не публикует —
    // participant = null и выше по дереву рендерится Anna-placeholder.
    const avatarParticipant =
      participants.find(
        (participant) =>
          participant.userId.startsWith("agent_") || participant.userId === `agent-${meetingId}`
      ) ?? null;
  if (state !== CallingState.JOINED && state !== CallingState.JOINING) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-600">Ожидание потока аватара…</div>;
  }
  return (
    <div className="stream-call-ui h-full w-full">
      <div className="stream-call-layout">
        {avatarParticipant ? (
          <ParticipantView participant={avatarParticipant} trackType="videoTrack" />
        ) : (
          // Pod ещё не опубликовал свой video-track — показываем статичный
          // портрет Анны как плейсхолдер, чтобы HR-колонка не выглядела
          // пустой / "ломалась". Убрать когда avatar-service начнёт реально
          // стримить видео.
          <AvatarPlaceholder />
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
  telemetryUnavailable?: boolean;
  meetingId: string | null;
  /** Show mic/camera/layout controls from Stream (often includes «video mode»). Default off for HR. */
  showStreamToolbar?: boolean;
  /** Status badge under the card title */
  showStatusBadge?: boolean;
  /** Остановить AI-сессию (звонок + бот) — см. useInterviewSession.stop */
  showStopAI?: boolean;
  onStopAI?: () => void;
  stopAIDisabled?: boolean;
  onTogglePauseAI?: () => void;
  pauseAIDisabled?: boolean;
  aiPaused?: boolean;
  sessionEnded?: boolean;
  uiState?: SessionUIState;
  /** Визуально выделить колонку HR как основную (AI-интервьюер). */
  emphasizePrimary?: boolean;
  /**
   * При true рендерим компактную "PiP" версию для mobile-portrait candidate-flow:
   * без заголовка, без бейджа статуса, без кнопок "Остановить бота". На lg+ та же
   * карточка автоматически возвращается в полный режим через wrapping CSS,
   * но контент мы сжимаем намеренно.
   */
  mobilePip?: boolean;
};

export function AvatarStreamCard({
  participantName,
  enabled,
  avatarReady,
  telemetryUnavailable = false,
  meetingId,
  showStreamToolbar = false,
  showStatusBadge = true,
  showStopAI = false,
  onStopAI,
  stopAIDisabled = false,
  onTogglePauseAI,
  pauseAIDisabled = false,
  aiPaused = false,
  sessionEnded = false,
  uiState,
  emphasizePrimary = true,
  mobilePip = false,
}: AvatarStreamCardProps) {
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<ReturnType<StreamVideoClient["call"]> | null>(null);
  const canRenderAvatarWindow = enabled && Boolean(client && call);
  const [busy, setBusy] = useState(false);
  const ended = Boolean(sessionEnded) || uiState === "completed";
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
    if (ended) {
      return;
    }
    if (!meetingId) {
      return;
    }
    setBusy(true);
    try {
      // We join the SFU as a passive viewer (`viewer-<meetingId>`). The avatar
      // pod publishes its video as `agent_<sessionId>` from RunPod, so we MUST
      // NOT reuse the same userId — Stream would treat us as a duplicate session
      // of the agent and the candidate would see no video tile.
      const response = await fetch("/api/stream/token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "spectator",
          meetingId,
          userId: `viewer-${meetingId}`,
          userName: participantName
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "Failed to issue HR stream token");
      }

      const payload = (await response.json()) as StreamTokenResponse;
      // StreamClientOptions extends Partial<AxiosRequestConfig>. Дефолт axios
      // внутри SDK — timeout=5000мс (см. @stream-io/video-client
      // index.es.js:«timeout: 5000»). На живом интервью 5с бюджет на HTTP
      // вызов Stream-API часто не хватает: бизнес-процесс ломается
      // сообщением «timeout of 5000ms exceeded» посреди диалога.
      // Переопределяем на 60_000мс — достаточно для любых штатных
      // coordinator/SFU round-trip даже при плохой сети.
      const streamClient = new StreamVideoClient({
        apiKey: payload.apiKey,
        token: payload.token,
        user: payload.user,
        options: { timeout: 60_000 }
      });
      const streamCall = streamClient.call(payload.callType, payload.callId);
      await streamCall.camera.disable().catch(() => undefined);
      await streamCall.microphone.disable().catch(() => undefined);
      await streamCall.join({ create: true, video: false });
      await streamCall.camera.disable().catch(() => undefined);
      await streamCall.microphone.disable().catch(() => undefined);

      setClient(streamClient);
      setCall(streamCall);
    } catch {
      autoJoinAttemptForRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [ended, meetingId, participantName]);

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
            {showStopAI && onTogglePauseAI ? (
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
                title={aiPaused ? "Возобновить работу HR аватара" : "Поставить HR аватар на паузу"}
              >
                {aiPaused ? "Продолжить" : "Пауза"}
              </button>
            ) : null}
            {showStopAI && onStopAI ? (
              <button
                type="button"
                disabled={stopAIDisabled || ended}
                onClick={onStopAI}
                className="h-10 min-h-10 w-full rounded-xl border border-rose-300/80 bg-rose-600 px-4 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] transition hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Остановить бота
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
        // До момента, пока viewer-клиент Stream не получил видео пода,
        // показываем статичный портрет Анны + маленький overlay со
        // статусом ("Подключаемся…" / "Ожидаем запуск"). Это визуально
        // совпадает с финальным видео-аватаром и избавляет кандидата
        // от пустой серой заглушки.
        <div className="relative h-full w-full">
          <AvatarPlaceholder emphasize={emphasizePrimary} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 px-4 pb-3 text-center">
            {(busy || (enabled && meetingId && !call)) ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-white/90" aria-hidden />
            ) : null}
            <p className="rounded-full bg-black/45 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {hrStatusLabel}
            </p>
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
