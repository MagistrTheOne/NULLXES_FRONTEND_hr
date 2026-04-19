"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CountdownState = {
  /** ms left until auto-end. null = countdown not active (lobby / completed). */
  msLeft: number | null;
  /** True when msLeft <= warn threshold; UI should show the warning dialog. */
  warning: boolean;
  /** True after countdown hit 0 (caller should invoke stop()). */
  expired: boolean;
};

interface UseSessionCountdownOptions {
  /** Whether the countdown should run. False during lobby / after completion. */
  active: boolean;
  /** Wall-clock ms when the meeting was joined (anchor for the countdown). */
  startedAtMs: number | null;
  /** Hard cap of the session in minutes. Defaults to 30. */
  maxMinutes?: number;
  /** Show the warning dialog when remaining time drops below this. */
  warnAtSeconds?: number;
}

interface UseSessionCountdownResult {
  state: CountdownState;
  /** Push expiry forward by N minutes (defaults to 5). Called from "Продлить". */
  extend: (byMinutes?: number) => void;
  /** Restore the countdown to fresh state. Called when a new session starts. */
  reset: () => void;
}

const IDLE_STATE: CountdownState = { msLeft: null, warning: false, expired: false };

/**
 * Drives the candidate-side session countdown: ticks every second, exposes
 * remaining ms, surfaces a warning band before expiry, fires `expired` once at 0.
 *
 * Pure UI clock — does NOT call stop() or anything else. The caller decides
 * what to do on `expired === true` (typically invoke stop() and reset()).
 */
export function useSessionCountdown(opts: UseSessionCountdownOptions): UseSessionCountdownResult {
  const { active, startedAtMs, maxMinutes = 30, warnAtSeconds = 60 } = opts;
  const maxMs = Math.max(60_000, Math.floor(maxMinutes * 60_000));
  const warnMs = Math.max(5_000, Math.floor(warnAtSeconds * 1_000));
  const offsetMsRef = useRef(0); // additional time granted via extend()
  const expiredFiredRef = useRef(false);
  const [state, setState] = useState<CountdownState>(IDLE_STATE);

  const compute = useCallback(
    (nowMs: number): CountdownState => {
      if (!active || startedAtMs == null) return IDLE_STATE;
      const elapsed = Math.max(0, nowMs - startedAtMs - offsetMsRef.current);
      const left = Math.max(0, maxMs - elapsed);
      const expired = left <= 0;
      const warning = !expired && left <= warnMs;
      return { msLeft: left, warning, expired };
    },
    [active, maxMs, startedAtMs, warnMs]
  );

  useEffect(() => {
    if (!active || startedAtMs == null) {
      offsetMsRef.current = 0;
      expiredFiredRef.current = false;
      setState(IDLE_STATE);
      return;
    }
    setState(compute(Date.now()));
    const interval = setInterval(() => {
      setState(compute(Date.now()));
    }, 1_000);
    return () => clearInterval(interval);
  }, [active, compute, startedAtMs]);

  // Make sure `expired` only fires once even if the consumer re-renders us
  // before they invoke reset() / stop the session.
  useEffect(() => {
    if (state.expired && !expiredFiredRef.current) {
      expiredFiredRef.current = true;
    }
  }, [state.expired]);

  const extend = useCallback((byMinutes: number = 5) => {
    const safeMinutes = Number.isFinite(byMinutes) && byMinutes > 0 ? byMinutes : 5;
    offsetMsRef.current += safeMinutes * 60_000;
    expiredFiredRef.current = false;
    setState(compute(Date.now()));
  }, [compute]);

  const reset = useCallback(() => {
    offsetMsRef.current = 0;
    expiredFiredRef.current = false;
    setState(IDLE_STATE);
  }, []);

  return { state, extend, reset };
}
