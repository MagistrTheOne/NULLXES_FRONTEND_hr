"use client";

import { useEffect, useState } from "react";
import { CallingState, useCallStateHooks } from "@stream-io/video-react-sdk";

export type ConnectionQuality = "excellent" | "fair" | "poor" | "offline" | "reconnecting";

export type ConnectionQualityReason =
  | "high_rtt"
  | "packet_loss"
  | "offline"
  | "reconnecting"
  | "unknown"
  | null;

export interface ConnectionQualityReading {
  quality: ConnectionQuality;
  rttMs?: number;
  packetLossPercent?: number;
  reason: ConnectionQualityReason;
}

const RTT_FAIR_MS = 100;
const RTT_POOR_MS = 300;
const LOSS_FAIR_PERCENT = 1;
const LOSS_POOR_PERCENT = 5;

function classify(rttMs: number | undefined, lossPct: number | undefined): {
  quality: ConnectionQuality;
  reason: ConnectionQualityReason;
} {
  const rtt = typeof rttMs === "number" && Number.isFinite(rttMs) ? rttMs : undefined;
  const loss = typeof lossPct === "number" && Number.isFinite(lossPct) ? lossPct : undefined;

  if ((rtt !== undefined && rtt >= RTT_POOR_MS) || (loss !== undefined && loss >= LOSS_POOR_PERCENT)) {
    return {
      quality: "poor",
      reason: rtt !== undefined && rtt >= RTT_POOR_MS ? "high_rtt" : "packet_loss"
    };
  }
  if ((rtt !== undefined && rtt >= RTT_FAIR_MS) || (loss !== undefined && loss >= LOSS_FAIR_PERCENT)) {
    return {
      quality: "fair",
      reason: rtt !== undefined && rtt >= RTT_FAIR_MS ? "high_rtt" : "packet_loss"
    };
  }
  if (rtt === undefined && loss === undefined) {
    // No stats yet — assume excellent rather than alarming the candidate.
    return { quality: "excellent", reason: null };
  }
  return { quality: "excellent", reason: null };
}

/**
 * Real-time WebRTC connection quality for the local participant of a Stream call.
 *
 * Combines three signals:
 *  - call calling state (RECONNECTING -> "reconnecting" — overrides everything)
 *  - browser online state (offline -> "offline")
 *  - publisher / subscriber RTT + packet loss from `useCallStatsReport()`
 *
 * Must be called from a component INSIDE a `<StreamCall>` context (otherwise
 * the SDK hooks throw / return undefined).
 */
export function useConnectionQuality(): ConnectionQualityReading {
  const { useCallStatsReport, useCallCallingState } = useCallStateHooks();
  const stats = useCallStatsReport();
  const callingState = useCallCallingState();
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!online) {
    return { quality: "offline", reason: "offline" };
  }
  if (callingState === CallingState.RECONNECTING) {
    return { quality: "reconnecting", reason: "reconnecting" };
  }

  // Pull RTT and loss from publisher stats first (own outbound traffic), then
  // subscriber stats as a secondary anchor. Use whichever is worse so the
  // candidate gets the most pessimistic reading they can act on.
  const pubRtt = stats?.publisherStats.averageRoundTripTimeInMs;
  const subRtt = stats?.subscriberStats.averageRoundTripTimeInMs;
  const rttMs = [pubRtt, subRtt]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce<number | undefined>((acc, value) => (acc === undefined ? value : Math.max(acc, value)), undefined);

  const audioLost = stats?.publisherAudioStats.totalPacketsLost ?? 0;
  const audioReceived = stats?.publisherAudioStats.totalPacketsReceived ?? 0;
  const subAudioLost = stats?.subscriberAudioStats.totalPacketsLost ?? 0;
  const subAudioReceived = stats?.subscriberAudioStats.totalPacketsReceived ?? 0;
  const totalLost = audioLost + subAudioLost;
  const totalSeen = audioReceived + subAudioReceived + totalLost;
  const packetLossPercent = totalSeen > 0 ? Math.min(100, (totalLost / totalSeen) * 100) : undefined;

  const { quality, reason } = classify(rttMs, packetLossPercent);
  const reading: ConnectionQualityReading = { quality, reason };
  if (typeof rttMs === "number") reading.rttMs = Math.round(rttMs);
  if (typeof packetLossPercent === "number") {
    reading.packetLossPercent = Math.round(packetLossPercent * 10) / 10;
  }
  return reading;
}
