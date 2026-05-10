/**
 * Browser WebSocket client for RunPod (or compatible) realtime facial coefficient bridge.
 * Reconnect with exponential backoff + jitter; application-level heartbeat ping/pong for RTT.
 */

export type RealtimeFacialCoefficients = {
  mouthOpen: number;
  blinkLeft: number;
  blinkRight: number;
  browRaise: number;
  emotionIntensity: number;
  idleMotion: number;
};

export const DEFAULT_REALTIME_FACIAL_COEFFICIENTS: RealtimeFacialCoefficients = {
  mouthOpen: 0,
  blinkLeft: 0,
  blinkRight: 0,
  browRaise: 0,
  emotionIntensity: 0,
  idleMotion: 0
};

export type BridgeRuntimeSnapshot = {
  echoMimic: string | null;
  a2f: string | null;
};

export type ParsedBridgeMessage =
  | { kind: "coefficients"; partial: Partial<RealtimeFacialCoefficients>; raw: unknown }
  | { kind: "runtime"; snapshot: BridgeRuntimeSnapshot; raw: unknown }
  | { kind: "pong"; clientT: number | null; raw: unknown }
  | { kind: "ping" }
  | { kind: "ignored"; raw: unknown };

const COEFF_KEYS: (keyof RealtimeFacialCoefficients)[] = [
  "mouthOpen",
  "blinkLeft",
  "blinkRight",
  "browRaise",
  "emotionIntensity",
  "idleMotion"
];

const SNAKE_MAP: Record<string, keyof RealtimeFacialCoefficients> = {
  mouth_open: "mouthOpen",
  blink_left: "blinkLeft",
  blink_right: "blinkRight",
  brow_raise: "browRaise",
  emotion_intensity: "emotionIntensity",
  idle_motion: "idleMotion"
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickCoefficients(obj: Record<string, unknown>): Partial<RealtimeFacialCoefficients> | null {
  const out: Partial<RealtimeFacialCoefficients> = {};
  let any = false;
  for (const key of COEFF_KEYS) {
    const v = asNumber(obj[key]);
    if (v != null) {
      out[key] = clamp01(v);
      any = true;
    }
  }
  for (const [snake, camel] of Object.entries(SNAKE_MAP)) {
    const v = asNumber(obj[snake]);
    if (v != null) {
      out[camel] = clamp01(v);
      any = true;
    }
  }
  return any ? out : null;
}

function unwrapRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as Record<string, unknown>;
}

/**
 * Parse bridge JSON: supports envelopes { type, coefficients }, { coeffs }, { data }, or flat object.
 */
export function parseBridgeWebSocketMessage(raw: unknown): ParsedBridgeMessage {
  const root = unwrapRecord(raw);
  if (!root) {
    return { kind: "ignored", raw };
  }

  const t = root.type;
  if (t === "ping") {
    return { kind: "ping" };
  }
  if (t === "pong") {
    const clientT = asNumber(root.t ?? root.clientT);
    return { kind: "pong", clientT, raw };
  }

  if (t === "runtime" || t === "runtimes" || t === "status") {
    const snap = extractRuntimeSnapshot(root);
    if (snap.echoMimic != null || snap.a2f != null) {
      return { kind: "runtime", snapshot: snap, raw };
    }
  }

  let body: Record<string, unknown> | null = root;
  if (typeof t === "string" && (t === "coefficients" || t === "facial" || t === "motion" || t === "frame")) {
    const inner =
      unwrapRecord(root.coefficients) ??
      unwrapRecord(root.coeffs) ??
      unwrapRecord(root.data) ??
      unwrapRecord(root.payload);
    body = inner ?? root;
  } else {
    const nested =
      unwrapRecord(root.coefficients) ?? unwrapRecord(root.coeffs) ?? unwrapRecord(root.data) ?? unwrapRecord(root.payload);
    if (nested) body = nested;
  }

  const picked = body ? pickCoefficients(body) : null;
  if (picked) {
    return { kind: "coefficients", partial: picked, raw };
  }

  const snap = extractRuntimeSnapshot(root);
  if (snap.echoMimic != null || snap.a2f != null) {
    return { kind: "runtime", snapshot: snap, raw };
  }

  return { kind: "ignored", raw };
}

function extractRuntimeSnapshot(root: Record<string, unknown>): BridgeRuntimeSnapshot {
  let echo: string | null = null;
  let a2f: string | null = null;

  const runtimes = unwrapRecord(root.runtimes);
  if (runtimes) {
    echo = readRuntimeField(runtimes, ["echoMimic", "echomimic", "echo_mimic", "gpu8889"]);
    a2f = readRuntimeField(runtimes, ["a2f", "A2F", "gpu8890"]);
  }
  echo ??= readRuntimeField(root, ["echoMimic", "echomimic", "echo_mimic"]);
  a2f ??= readRuntimeField(root, ["a2f", "A2F"]);

  return { echoMimic: echo, a2f };
}

function readRuntimeField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "boolean") return v ? "ready" : "offline";
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function mergeCoefficients(
  base: RealtimeFacialCoefficients,
  partial: Partial<RealtimeFacialCoefficients>
): RealtimeFacialCoefficients {
  return { ...base, ...partial };
}

/** Read NEXT_PUBLIC_RUNPOD_BRIDGE_WS_URL or optional override; normalize https→wss and default path /ws/live. */
export function resolveRunpodBridgeWebSocketUrl(override?: string | null): string | null {
  const raw = (override ?? (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_RUNPOD_BRIDGE_WS_URL : undefined) ?? "")
    .trim();
  if (!raw) return null;
  try {
    if (/^wss?:\/\//i.test(raw)) {
      return raw;
    }
    const u = new URL(raw);
    const proto = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : null;
    if (!proto) return null;
    let path = u.pathname || "/";
    if (path === "/" || path === "") {
      path = "/ws/live";
    } else if (!path.includes("ws/live")) {
      path = path.replace(/\/$/, "") + "/ws/live";
    }
    return `${proto}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

export type RealtimeAvatarSocketHandlers = {
  onConnectionChange?: (connected: boolean) => void;
  onReconnectingChange?: (reconnecting: boolean) => void;
  onParsedMessage?: (msg: ParsedBridgeMessage, rawText: string) => void;
  onRoundTripMs?: (ms: number) => void;
  onError?: (message: string) => void;
};

export type ConnectRealtimeAvatarSocketOptions = {
  url: string;
  handlers?: RealtimeAvatarSocketHandlers;
  /** Client JSON ping interval (browser WS has no native ping). */
  heartbeatIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
};

export type RealtimeAvatarSocketHandle = {
  disconnect: () => void;
  /** Current WebSocket readyState, or CLOSED if not connected. */
  getReadyState: () => number;
};

const WS_OPEN = 1;

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * Math.min(800, ms * 0.25));
}

/**
 * Maintains a single WebSocket with auto-reconnect (exponential backoff + jitter)
 * and periodic `{ type: "ping", t }` for latency measurement when server replies with `pong`.
 */
export function connectRealtimeAvatarSocket(options: ConnectRealtimeAvatarSocketOptions): RealtimeAvatarSocketHandle {
  const {
    url,
    handlers = {},
    heartbeatIntervalMs = 20_000,
    initialBackoffMs = 500,
    maxBackoffMs = 30_000,
    backoffMultiplier = 1.85
  } = options;

  let ws: WebSocket | null = null;
  let manualClose = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let lastPingSentAt: number | null = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = () => {
    clearHeartbeat();
    if (heartbeatIntervalMs <= 0) return;
    heartbeatTimer = window.setInterval(() => {
      if (!ws || ws.readyState !== WS_OPEN) return;
      lastPingSentAt = Date.now();
      try {
        ws.send(JSON.stringify({ type: "ping", t: lastPingSentAt }));
      } catch {
        // ignore
      }
    }, heartbeatIntervalMs);
  };

  const scheduleReconnect = () => {
    if (manualClose) return;
    clearReconnect();
    handlers.onReconnectingChange?.(true);
    const exp = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(backoffMultiplier, attempt));
    attempt += 1;
    const delay = jitter(exp);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = () => {
    if (manualClose) return;
    clearReconnect();
    try {
      ws = new WebSocket(url);
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : "websocket_construct_failed");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempt = 0;
      handlers.onReconnectingChange?.(false);
      handlers.onConnectionChange?.(true);
      startHeartbeat();
    };

    ws.onmessage = (ev) => {
      const sock = ev.target as WebSocket;
      const text = typeof ev.data === "string" ? ev.data : "";
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
      }
      if (parsed != null) {
        const msg = parseBridgeWebSocketMessage(parsed);
        if (msg.kind === "ping" && sock.readyState === WS_OPEN) {
          try {
            sock.send(JSON.stringify({ type: "pong", t: Date.now() }));
          } catch {
            // ignore
          }
        }
        if (msg.kind === "pong" && lastPingSentAt != null) {
          handlers.onRoundTripMs?.(Date.now() - lastPingSentAt);
        }
        handlers.onParsedMessage?.(msg, text);
      }
    };

    ws.onerror = () => {
      handlers.onError?.("websocket_error");
    };

    ws.onclose = () => {
      clearHeartbeat();
      handlers.onConnectionChange?.(false);
      ws = null;
      if (!manualClose) {
        scheduleReconnect();
      } else {
        handlers.onReconnectingChange?.(false);
      }
    };
  };

  open();

  return {
    disconnect: () => {
      manualClose = true;
      clearReconnect();
      clearHeartbeat();
      if (ws) {
        try {
          ws.close(1000, "client_disconnect");
        } catch {
          // ignore
        }
        ws = null;
      }
      handlers.onConnectionChange?.(false);
      handlers.onReconnectingChange?.(false);
    },
    getReadyState: () => ws?.readyState ?? WebSocket.CLOSED
  };
}
