"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  connectRealtimeAvatarSocket,
  DEFAULT_REALTIME_FACIAL_COEFFICIENTS,
  mergeCoefficients,
  type BridgeRuntimeSnapshot,
  type ParsedBridgeMessage,
  type RealtimeFacialCoefficients,
  resolveRunpodBridgeWebSocketUrl
} from "@/lib/realtime-avatar-socket";

export type UseRealtimeFacialMotionOptions = {
  /** When false, disconnects and clears reconnect timers. Default true. */
  enabled?: boolean;
  /** Override env `NEXT_PUBLIC_RUNPOD_BRIDGE_WS_URL` (full `wss://…/ws/live` or https base). */
  bridgeUrlOverride?: string | null;
};

export type UseRealtimeFacialMotionResult = {
  connected: boolean;
  coefficients: RealtimeFacialCoefficients;
  latency: number | null;
  reconnecting: boolean;
  /** Populated when bridge sends runtime telemetry in-band (no HTTP polling). */
  bridgeRuntime: BridgeRuntimeSnapshot;
  /** Resolved WS URL, or null if not configured. */
  bridgeWsUrl: string | null;
};

const EMPTY_RUNTIME: BridgeRuntimeSnapshot = { echoMimic: null, a2f: null };

export function useRealtimeFacialMotion(options?: UseRealtimeFacialMotionOptions): UseRealtimeFacialMotionResult {
  const enabled = options?.enabled ?? true;
  const bridgeWsUrl = useMemo(
    () => resolveRunpodBridgeWebSocketUrl(options?.bridgeUrlOverride ?? null),
    [options?.bridgeUrlOverride]
  );

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [coefficients, setCoefficients] = useState<RealtimeFacialCoefficients>(DEFAULT_REALTIME_FACIAL_COEFFICIENTS);
  const [latency, setLatency] = useState<number | null>(null);
  const [bridgeRuntime, setBridgeRuntime] = useState<BridgeRuntimeSnapshot>(EMPTY_RUNTIME);

  const coeffRef = useRef<RealtimeFacialCoefficients>(DEFAULT_REALTIME_FACIAL_COEFFICIENTS);

  useEffect(() => {
    if (!enabled || !bridgeWsUrl) {
      setConnected(false);
      setReconnecting(false);
      coeffRef.current = DEFAULT_REALTIME_FACIAL_COEFFICIENTS;
      setCoefficients(DEFAULT_REALTIME_FACIAL_COEFFICIENTS);
      setBridgeRuntime(EMPTY_RUNTIME);
      return;
    }

    const handleParsed = (msg: ParsedBridgeMessage) => {
      if (msg.kind === "coefficients") {
        coeffRef.current = mergeCoefficients(DEFAULT_REALTIME_FACIAL_COEFFICIENTS, msg.partial);
        setCoefficients(coeffRef.current);
      }
      if (msg.kind === "runtime") {
        setBridgeRuntime((prev) => ({
          echoMimic: msg.snapshot.echoMimic ?? prev.echoMimic,
          a2f: msg.snapshot.a2f ?? prev.a2f
        }));
      }
    };

    const socket = connectRealtimeAvatarSocket({
      url: bridgeWsUrl,
      heartbeatIntervalMs: 15_000,
      handlers: {
        onConnectionChange: setConnected,
        onReconnectingChange: setReconnecting,
        onParsedMessage: (msg) => handleParsed(msg),
        onRoundTripMs: (ms) => setLatency(Math.round(ms * 10) / 10)
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [enabled, bridgeWsUrl]);

  return {
    connected,
    coefficients,
    latency,
    reconnecting,
    bridgeRuntime,
    bridgeWsUrl
  };
}
