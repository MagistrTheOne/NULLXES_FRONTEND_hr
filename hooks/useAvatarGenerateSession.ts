"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { flushSync } from "react-dom";

import {
  AVATAR_WARMUP_LOG_LINES,
  pickAvatarVideoUrl,
  sanitizeAvatarUserMessage,
  type AvatarSessionState
} from "@/lib/avatar-session-state";
import { fetchAvatarJob, postAvatarGenerate, type AvatarGenerateJob } from "@/lib/avatarGenerateApi";

const POLL_MS = 2000;
const HYDRATE_CROSSFADE_MS = 520;
const BOOT_LINE_INTERVAL_MS = 720;

/** Browser timers are numeric handles (distinct from NodeJS.Timeout in some TS configs). */
type BrowserTimeout = number;
type BrowserInterval = number;

function clearTimerRef(ref: MutableRefObject<BrowserTimeout | null>): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function clearIntervalRef(ref: MutableRefObject<BrowserInterval | null>): void {
  if (ref.current !== null) {
    window.clearInterval(ref.current);
    ref.current = null;
  }
}

export type UseAvatarGenerateSessionResult = {
  sessionState: AvatarSessionState;
  job: AvatarGenerateJob | null;
  bootLogs: readonly string[];
  generatedElapsedSec: number | null;
  sessionError: string | null;
  startSession: (form: FormData) => Promise<void>;
  resetSession: () => void;
  onHydrationReady: () => void;
};

export function useAvatarGenerateSession(): UseAvatarGenerateSessionResult {
  const [sessionState, setSessionState] = useState<AvatarSessionState>("idle");
  const [job, setJob] = useState<AvatarGenerateJob | null>(null);
  const [bootLogs, setBootLogs] = useState<string[]>([]);
  const [generatedElapsedSec, setGeneratedElapsedSec] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const sessionStartMsRef = useRef<number | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const pollRef = useRef<BrowserInterval | null>(null);
  const bootIntervalRef = useRef<BrowserInterval | null>(null);
  const hydrateRef = useRef<BrowserTimeout | null>(null);
  const bootLineIndexRef = useRef(0);
  const hydrationDoneRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopBootLogTicker = useCallback(() => {
    clearIntervalRef(bootIntervalRef);
    bootLineIndexRef.current = 0;
  }, []);

  const resetSession = useCallback(() => {
    stopPolling();
    clearTimerRef(hydrateRef);
    stopBootLogTicker();
    jobIdRef.current = null;
    sessionStartMsRef.current = null;
    hydrationDoneRef.current = false;
    setJob(null);
    setBootLogs([]);
    setGeneratedElapsedSec(null);
    setSessionError(null);
    setSessionState("idle");
  }, [stopBootLogTicker, stopPolling]);

  const startBootLogTicker = useCallback(() => {
    stopBootLogTicker();
    setBootLogs([]);
    bootLineIndexRef.current = 0;
    const pushLine = (): void => {
      const i = bootLineIndexRef.current;
      if (i >= AVATAR_WARMUP_LOG_LINES.length) return;
      const line = AVATAR_WARMUP_LOG_LINES[i];
      bootLineIndexRef.current = i + 1;
      setBootLogs((prev) => [...prev, line]);
    };
    pushLine();
    bootIntervalRef.current = window.setInterval(() => {
      pushLine();
      if (bootLineIndexRef.current >= AVATAR_WARMUP_LOG_LINES.length) {
        stopBootLogTicker();
      }
    }, BOOT_LINE_INTERVAL_MS) as unknown as BrowserInterval;
  }, [stopBootLogTicker]);

  const beginInitializingPhase = useCallback(() => {
    flushSync(() => {
      setSessionState("initializing");
    });
    startBootLogTicker();
  }, [startBootLogTicker]);

  const onHydrationReady = useCallback(() => {
    if (hydrationDoneRef.current) return;
    hydrationDoneRef.current = true;
    clearTimerRef(hydrateRef);
    hydrateRef.current = window.setTimeout(() => {
      setSessionState("completed");
      const start = sessionStartMsRef.current;
      if (start != null) {
        setGeneratedElapsedSec(Math.max(0, (Date.now() - start) / 1000));
      }
    }, HYDRATE_CROSSFADE_MS) as unknown as BrowserTimeout;
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      const tick = (): void => {
        void fetchAvatarJob(jobId)
          .then(({ job: next }) => setJob(next))
          .catch(() => undefined);
      };
      pollRef.current = window.setInterval(tick, POLL_MS) as unknown as BrowserInterval;
      void tick();
    },
    [stopPolling]
  );

  const startSession = useCallback(
    async (form: FormData) => {
      resetSession();
      hydrationDoneRef.current = false;
      sessionStartMsRef.current = Date.now();
      setSessionState("uploading");
      setSessionError(null);
      try {
        const { jobId } = await postAvatarGenerate(form);
        jobIdRef.current = jobId;
        flushSync(() => {
          setSessionState("queued");
        });
        beginInitializingPhase();

        const first = await fetchAvatarJob(jobId);
        setJob(first.job);
        startPolling(jobId);
      } catch (e) {
        const raw = e instanceof Error ? e.message : "generate_failed";
        setSessionError(sanitizeAvatarUserMessage(raw));
        setSessionState("failed");
        stopBootLogTicker();
        stopPolling();
      }
    },
    [beginInitializingPhase, resetSession, startPolling, stopBootLogTicker, stopPolling]
  );

  useEffect(() => {
    if (!job) return;
    if (job.state === "failed") {
      stopPolling();
      stopBootLogTicker();
      setSessionError(sanitizeAvatarUserMessage(job.errorMessage ?? "Generation failed"));
      setSessionState("failed");
      return;
    }
    if (job.state === "processing") {
      stopBootLogTicker();
      setSessionState("processing");
      return;
    }
    if (job.state === "hydrating") {
      const url = pickAvatarVideoUrl(job);
      if (!url) return;
      stopBootLogTicker();
      setSessionState((prev) => (prev === "failed" ? prev : "hydrating"));
      return;
    }
    if (job.state === "completed") {
      const url = pickAvatarVideoUrl(job);
      if (!url) {
        stopPolling();
        stopBootLogTicker();
        setSessionError(sanitizeAvatarUserMessage("No media URL returned for this session"));
        setSessionState("failed");
        return;
      }
      stopPolling();
      stopBootLogTicker();
      setSessionState((prev) => {
        if (prev === "failed") return prev;
        return "hydrating";
      });
      return;
    }
  }, [job, stopBootLogTicker, stopPolling]);

  useEffect(() => {
    return () => {
      stopPolling();
      clearTimerRef(hydrateRef);
      stopBootLogTicker();
    };
  }, [stopBootLogTicker, stopPolling]);

  useEffect(() => {
    if (sessionState !== "hydrating") return;
    if (hydrationDoneRef.current) return;
    const t = window.setTimeout(() => {
      onHydrationReady();
    }, 5000) as unknown as BrowserTimeout;
    return () => window.clearTimeout(t);
  }, [sessionState, onHydrationReady]);

  return {
    sessionState,
    job,
    bootLogs,
    generatedElapsedSec,
    sessionError,
    startSession,
    resetSession,
    onHydrationReady
  };
}
