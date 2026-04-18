import { createRealtimeSession, getRealtimeToken, sendRealtimeEvent } from "@/lib/api";

export type WebRtcConnectionState = "idle" | "connecting" | "connected" | "failed" | "closed";

function normalizeSdp(input: string): string {
  const normalized = input.replace(/\r?\n/g, "\r\n").trim();
  return `${normalized}\r\n`;
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

  constructor(options?: {
    onStateChange?: (state: WebRtcConnectionState) => void;
    onRemoteStream?: (stream: MediaStream) => void;
  }) {
    this.onState = options?.onStateChange;
    this.onRemoteStream = options?.onRemoteStream;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
      if (typeof console !== "undefined") {
        if (type === "error" || type.endsWith(".error")) {
          console.error("[OpenAI Realtime]", type, parsed);
        } else if (isCritical) {
          console.debug("[OpenAI Realtime]", type, parsed);
        }
      }
      if (isCritical && this.sessionId) {
        void sendRealtimeEvent(this.sessionId, {
          type: `openai.${type}`,
          source: "openai",
          payload: parsed
        }).catch(() => {
          // best-effort telemetry; never let upstream errors block the agent
        });
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
    this.sendToOpenAiDataChannel(payload);
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
