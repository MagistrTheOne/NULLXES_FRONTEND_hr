"use client";
/* eslint-disable react-hooks/refs */

import { useEffect, useRef, useState } from "react";

type UseSilenceDetectorInput = {
  enabled: boolean;
  joined: boolean;
  hasDominantSpeaker: boolean;
  thresholdMs?: number;
};

type UseSilenceDetectorResult = {
  silenceMs: number;
  isSilent: boolean;
};

export function useSilenceDetector({
  enabled,
  joined,
  hasDominantSpeaker,
  thresholdMs = 8_000
}: UseSilenceDetectorInput): UseSilenceDetectorResult {
  const silenceSinceRef = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    if (!enabled || !joined || hasDominantSpeaker) {
      silenceSinceRef.current = null;
      return;
    }
    if (!silenceSinceRef.current) {
      silenceSinceRef.current = Date.now();
    }
  }, [enabled, hasDominantSpeaker, joined]);

  useEffect(() => {
    if (!enabled || !joined || hasDominantSpeaker) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled, hasDominantSpeaker, joined]);

  const silenceMs = silenceSinceRef.current ? Math.max(0, nowMs - silenceSinceRef.current) : 0;
  return { silenceMs, isSilent: silenceMs >= thresholdMs };
}

