import { createRealtimeSession, getRealtimeToken, sendRealtimeEvent } from "@/lib/api";

export type WebRtcConnectionState = "idle" | "connecting" | "connected" | "failed" | "closed";
export type AudioPreflightResult =
  | { ok: true }
  | { ok: false; code: "permission_denied" | "device_unavailable" | "unknown"; message: string };

export type MediaDevicesCheckResult =
  | { ok: true; stream: MediaStream; hasVideo: boolean; hasAudio: boolean; warning?: string }
  | { ok: false; code: "permission_denied" | "device_unavailable" | "unknown"; message: string };

/**
 * Одна проверка камеры + микрофона для лобби кандидата (до Stream/WebRTC интервью).
 * Вызывающий обязан остановить треки, когда превью больше не нужно.
 */
export async function acquireLocalMediaPreviewStream(): Promise<MediaDevicesCheckResult> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000
  };
  const videoConstraints: MediaTrackConstraints = {
    facingMode: "user",
    width: { ideal: 640 },
    height: { ideal: 480 }
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints
    });
    return { ok: true, stream, hasAudio: true, hasVideo: stream.getVideoTracks().length > 0 };
  } catch (error) {
    // Camera may be absent/blocked while microphone is still available.
    // Fallback to audio-only so candidate can continue without hard stop.
    try {
      const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
      return {
        ok: true,
        stream: audioOnlyStream,
        hasAudio: audioOnlyStream.getAudioTracks().length > 0,
        hasVideo: false,
        warning: "Камера недоступна. Продолжим с микрофоном без видео."
      };
    } catch (audioOnlyError) {
      if (audioOnlyError instanceof DOMException && audioOnlyError.name === "NotAllowedError") {
        return {
          ok: false,
          code: "permission_denied",
          message: "Нет доступа к камере или микрофону. Разрешите доступ в браузере и повторите."
        };
      }
      if (
        audioOnlyError instanceof DOMException &&
        (audioOnlyError.name === "NotFoundError" || audioOnlyError.name === "NotReadableError")
      ) {
        return {
          ok: false,
          code: "device_unavailable",
          message: "Камера или микрофон недоступны. Проверьте устройства и повторите."
        };
      }
      void error;
      return {
        ok: false,
        code: "unknown",
        message: "Не удалось проверить камеру и микрофон."
      };
    }
  }
}

export async function runAudioInputPreflight(): Promise<AudioPreflightResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      },
      video: false
    });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return {
        ok: false,
        code: "permission_denied",
        message: "Нет доступа к микрофону. Разрешите доступ и повторите запуск."
      };
    }
    if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "NotReadableError")) {
      return {
        ok: false,
        code: "device_unavailable",
        message: "Микрофон недоступен. Проверьте устройство и повторите запуск."
      };
    }
    return {
      ok: false,
      code: "unknown",
      message: "Не удалось проверить микрофон перед запуском интервью."
    };
  }
}

function normalizeSdp(input: string): string {
  const normalized = input.replace(/\r?\n/g, "\r\n").trim();
  return `${normalized}\r\n`;
}

/**
 * Whitelist of OpenAI Realtime API client event types.
 * Anything outside this list is treated as gateway-only telemetry and is NOT
 * forwarded over the WebRTC DataChannel — otherwise OpenAI replies with an
 * `error` event ("Unknown parameter" / "unknown_event_type") which pollutes
 * the session.
 *
 * Source: https://platform.openai.com/docs/api-reference/realtime_client_events
 */
const OPENAI_CLIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.update",
  "input_audio_buffer.append",
  "input_audio_buffer.commit",
  "input_audio_buffer.clear",
  "conversation.item.create",
  "conversation.item.added",
  "conversation.item.delete",
  "conversation.item.truncate",
  "conversation.item.retrieve",
  "response.create",
  "response.cancel",
  "transcription_session.update",
  "output_audio_buffer.clear"
]);

function isOpenAiClientEventType(value: unknown): boolean {
  return typeof value === "string" && OPENAI_CLIENT_EVENT_TYPES.has(value);
}

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onIceStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onIceStateChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onIceStateChange);
  });
}

/**
 * Структурированное событие, прилетающее ОТ OpenAI Realtime через DataChannel.
 * Передаётся в опциональный `onOpenAiEvent` callback — нужен для UI-индикаторов
 * фазы интервью / состояния агента и для сбора транскрипта.
 *
 * Полный набор серверных событий: https://platform.openai.com/docs/api-reference/realtime_server_events
 */
export interface OpenAiServerEvent {
  type: string;
  payload: Record<string, unknown>;
}

export class WebRtcInterviewClient {
  private peerConnection: RTCPeerConnection | null = null;
  private mediaStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingEvents: Array<Record<string, unknown>> = [];
  private sessionId: string | null = null;
  private audioInputEnabled = true;
  private state: WebRtcConnectionState = "idle";
  private onState?: (state: WebRtcConnectionState) => void;
  private onRemoteStream?: (stream: MediaStream) => void;
  private onOpenAiEvent?: (event: OpenAiServerEvent) => void;

  constructor(options?: {
    onStateChange?: (state: WebRtcConnectionState) => void;
    onRemoteStream?: (stream: MediaStream) => void;
    onOpenAiEvent?: (event: OpenAiServerEvent) => void;
  }) {
    this.onState = options?.onStateChange;
    this.onRemoteStream = options?.onRemoteStream;
    this.onOpenAiEvent = options?.onOpenAiEvent;
  }

  /** Замена listener'а после конструктора (например React effect, который пере-биндит). */
  setOpenAiEventListener(listener: ((event: OpenAiServerEvent) => void) | undefined): void {
    this.onOpenAiEvent = listener;
  }

  private setState(nextState: WebRtcConnectionState): void {
    this.state = nextState;
    this.onState?.(nextState);
  }

  async connect(): Promise<{ sessionId: string }> {
    // If a previous connect() is still in flight (or left a stale PC), close it
    // before starting a new one. Otherwise the old PeerConnection sits in pending
    // setRemoteDescription state and a refresh / re-entry crashes with
    // `signalingState === 'closed'` when the late answer finally arrives.
    if (this.peerConnection) {
      this.close();
    }

    this.setState("connecting");
    await getRealtimeToken();
    if (this.peerConnection) {
      // close() was called while we were awaiting the token — bail out cleanly.
      throw new Error("connect aborted: client closed during token fetch");
    }

    const pc = new RTCPeerConnection();
    this.peerConnection = pc;

    pc.addTransceiver("audio", { direction: "sendrecv" });

    try {
      // Explicit audio constraints — browser defaults vary across Chrome/Safari/Firefox.
      // For HR-interview UX we MUST have noise suppression and AEC on (room noise, fan,
      // keyboard, distant TV). channelCount=1 keeps payload small for OpenAI Realtime
      // and avoids stereo dropouts on flaky uplinks.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000
        },
        video: false
      });
      if (this.peerConnection !== pc || pc.signalingState === "closed") {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("connect aborted: peer connection replaced during getUserMedia");
      }
      this.mediaStream = stream;
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
      this.setAudioInputEnabled(this.audioInputEnabled);
    } catch (mediaErr) {
      if (this.peerConnection !== pc) throw mediaErr;
      // Audio capture is optional for initial prototype.
    }

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        this.onRemoteStream?.(remoteStream);
      }
    };

    // OpenAI Realtime API GA requires the DataChannel name to be exactly "oai-events".
    // Any other name causes OpenAI to silently ignore both client events AND server events
    // sent over the channel — symptom: agent never speaks, session.update / response.create
    // appear successful in our logs but never trigger any response from the model.
    const dataChannel = pc.createDataChannel("oai-events");
    this.dataChannel = dataChannel;
    dataChannel.onopen = () => {
      if (this.sessionId) {
        void sendRealtimeEvent(this.sessionId, {
          type: "session.update",
          source: "frontend",
          message: "datachannel_open"
        });
      }
      this.flushPendingEvents();
    };
    // Listen to OpenAI Realtime events sent back over the same DataChannel.
    // Without this we never see `response.error`, `error`, `response.done`, etc. —
    // and silent failures (e.g. invalid session.update) make the agent appear "stuck".
    dataChannel.onmessage = (event: MessageEvent<string>) => {
      let parsed: { type?: string; [k: string]: unknown } | null = null;
      try {
        parsed = JSON.parse(event.data) as { type?: string; [k: string]: unknown };
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== "string") return;
      const type = parsed.type;
      const isCritical =
        type === "error" ||
        type.endsWith(".error") ||
        type === "response.created" ||
        type === "response.done" ||
        type === "response.cancelled" ||
        type === "session.created" ||
        type === "session.updated" ||
        type === "rate_limits.updated";
      // prod: suppress console noise; UI surfaces errors via state/toasts
      if (isCritical && this.sessionId) {
        void sendRealtimeEvent(this.sessionId, {
          type: `openai.${type}`,
          source: "openai",
          payload: parsed
        }).catch(() => {
          // best-effort telemetry; never let upstream errors block the agent
        });
      }
      // Always notify local listener — UI uses these for phase / agent-state /
      // captions even when we don't ship them to the gateway. Wrap in try so
      // a misbehaving listener can never break the realtime loop.
      if (this.onOpenAiEvent) {
        try {
          this.onOpenAiEvent({ type, payload: parsed });
        } catch {
          // ignore: listener errors must not break realtime loop
        }
      }
    };
    dataChannel.onerror = (event: Event) => {
      if (typeof console !== "undefined") {
        console.error("[OpenAI Realtime] datachannel error", event);
      }
      if (this.sessionId) {
        void sendRealtimeEvent(this.sessionId, {
          type: "openai.datachannel.error",
          source: "frontend",
          message: "datachannel error event"
        }).catch(() => undefined);
      }
    };

    const isAborted = (state: RTCSignalingState | string): boolean =>
      this.peerConnection !== pc || String(state) === "closed";

    const offer = await pc.createOffer();
    if (isAborted(pc.signalingState)) {
      throw new Error("connect aborted: closed before setLocalDescription");
    }
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    if (isAborted(pc.signalingState)) {
      throw new Error("connect aborted: closed during ICE gathering");
    }

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) {
      this.setState("failed");
      throw new Error("Failed to generate local SDP offer");
    }

    const normalizedLocalSdp = normalizeSdp(localSdp);
    const { answerSdp, sessionId } = await createRealtimeSession(normalizedLocalSdp);
    if (isAborted(pc.signalingState)) {
      // Gateway answered but our PC was torn down meanwhile (page refresh, double-connect, etc).
      // Drop the orphaned session id silently — server-side idle sweeper will close it.
      throw new Error("connect aborted: peer connection closed before applying SDP answer");
    }
    if (!sessionId) {
      this.setState("failed");
      throw new Error("Gateway response missing session id");
    }
    this.sessionId = sessionId;

    await pc.setRemoteDescription({
      type: "answer",
      sdp: normalizeSdp(answerSdp)
    });

    this.setState("connected");
    return { sessionId };
  }

  async postEvent(payload: Record<string, unknown>): Promise<void> {
    // Only forward events with types that OpenAI Realtime API actually understands.
    // Our internal telemetry (observer.*, candidate.stream.*, hr.agent.*, etc.)
    // is gateway-only — sending it to OpenAI causes "unknown_event_type" errors that
    // pollute the session and may interfere with response generation.
    if (isOpenAiClientEventType(payload.type)) {
      this.sendToOpenAiDataChannel(payload);
    }
    if (this.sessionId) {
      await sendRealtimeEvent(this.sessionId, payload);
    }
  }

  close(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.dataChannel = null;
    this.pendingEvents = [];
    this.sessionId = null;
    this.setState("closed");
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getState(): WebRtcConnectionState {
    return this.state;
  }

  setAudioInputEnabled(enabled: boolean): void {
    this.audioInputEnabled = enabled;
    if (!this.mediaStream) {
      return;
    }
    for (const track of this.mediaStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  isAudioInputEnabled(): boolean {
    return this.audioInputEnabled;
  }

  private sendToOpenAiDataChannel(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(serialized);
      return;
    }
    this.pendingEvents.push(payload);
  }

  private flushPendingEvents(): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return;
    }
    while (this.pendingEvents.length > 0) {
      const next = this.pendingEvents.shift();
      if (!next) {
        continue;
      }
      this.dataChannel.send(JSON.stringify(next));
    }
  }
}
