"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type PresenceEvent = {
  id: string;
  atMs: number;
  offsetMs: number;
  text: string;
};

type UsePresenceLogInput = {
  sessionStartedAt: number | null;
  limit?: number;
};

type UsePresenceLogResult = {
  events: PresenceEvent[];
  pushEvent: (text: string) => void;
};

export function usePresenceLog({ sessionStartedAt, limit = 20 }: UsePresenceLogInput): UsePresenceLogResult {
  const [events, setEvents] = useState<PresenceEvent[]>([]);
  const lastEventAtByKeyRef = useRef<Record<string, number>>({});

  const pushEvent = useCallback(
    (text: string) => {
      const now = Date.now();
      const key = text.toLowerCase();
      const minGapMs = key.includes("активный спикер") ? 1_500 : 0;
      const lastAt = lastEventAtByKeyRef.current[key] ?? 0;
      if (now - lastAt < minGapMs) return;
      lastEventAtByKeyRef.current[key] = now;
      const event: PresenceEvent = {
        id: typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `presence-${now}`,
        atMs: now,
        offsetMs: sessionStartedAt ? Math.max(0, now - sessionStartedAt) : 0,
        text
      };
      setEvents((prev) => [...prev.slice(-(limit - 1)), event]);
    },
    [limit, sessionStartedAt]
  );

  return useMemo(() => ({ events, pushEvent }), [events, pushEvent]);
}

