"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAvatarGenerateSession } from "@/hooks/useAvatarGenerateSession";
import { fetchAvatarHealth, type AvatarHealthResponse } from "@/lib/avatarGenerateApi";
import { pickAvatarVideoUrl, type AvatarSessionState } from "@/lib/avatar-session-state";

function sessionLabel(s: AvatarSessionState): string {
  switch (s) {
    case "idle":
      return "Idle";
    case "uploading":
      return "Uploading";
    case "queued":
      return "Queued";
    case "initializing":
      return "Initializing";
    case "processing":
      return "Processing";
    case "hydrating":
      return "Hydrating";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return s;
  }
}

function ProgressRing({ active }: { active: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex items-center justify-center ${active ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
      aria-hidden
    >
      <div className="relative size-24">
        <div className="absolute inset-0 rounded-full border-2 border-indigo-200/80" />
        <div
          className="absolute inset-0 rounded-full border-2 border-transparent border-t-indigo-600 border-r-indigo-500 animate-spin"
          style={{ animationDuration: "1.1s" }}
        />
      </div>
    </div>
  );
}

function AvatarWarmupPlaceholder({
  showRing,
  bootLogs
}: {
  showRing: boolean;
  bootLogs: readonly string[];
}) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-slate-100">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className="absolute -left-1/4 top-1/4 size-64 rounded-full bg-indigo-500/30 blur-3xl animate-pulse" />
        <div className="absolute -right-1/4 bottom-0 size-72 rounded-full bg-violet-500/25 blur-3xl animate-pulse" style={{ animationDelay: "0.4s" }} />
      </div>
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <div className="relative">
          <div className="absolute inset-0 scale-110 rounded-full bg-indigo-400/20 blur-md animate-pulse" />
          <div className="relative flex size-28 items-center justify-center rounded-full border border-white/10 bg-white/5 shadow-inner ring-2 ring-indigo-400/30">
            <svg viewBox="0 0 64 64" className="size-14 text-indigo-200/90" aria-hidden>
              <circle cx="32" cy="22" r="10" fill="currentColor" opacity="0.85" />
              <path
                d="M16 52c4-12 28-12 32 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                opacity="0.9"
              />
            </svg>
          </div>
        </div>
        <p className="text-center text-xs font-medium uppercase tracking-[0.2em] text-indigo-200/80">Neural avatar</p>
      </div>
      {bootLogs.length > 0 ? (
        <div className="relative z-10 max-h-[40%] overflow-y-auto border-t border-white/10 bg-black/35 px-4 py-3 font-mono text-[11px] leading-relaxed text-emerald-200/95">
          {bootLogs.map((line, i) => (
            <div key={`${i}-${line}`} className="transition-opacity duration-300">
              <span className="text-emerald-500/90">› </span>
              {line}
            </div>
          ))}
        </div>
      ) : null}
      <ProgressRing active={showRing} />
    </div>
  );
}

export function AvatarGenerateStudio() {
  const [health, setHealth] = useState<AvatarHealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const imageRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLInputElement | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [crossfadeMedia, setCrossfadeMedia] = useState(false);

  const {
    sessionState,
    job,
    bootLogs,
    generatedElapsedSec,
    sessionError,
    startSession,
    resetSession,
    onHydrationReady
  } = useAvatarGenerateSession();

  const loadHealth = useCallback(async () => {
    try {
      setHealthError(null);
      const h = await fetchAvatarHealth();
      setHealth(h);
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : "health_failed");
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    if (sessionState === "hydrating") {
      const id = window.requestAnimationFrame(() => {
        setCrossfadeMedia(true);
      });
      return () => window.cancelAnimationFrame(id);
    }
    if (sessionState === "idle" || sessionState === "failed") {
      setCrossfadeMedia(false);
    }
  }, [sessionState]);

  const onGenerate = async () => {
    setLastError(null);
    const image = imageRef.current?.files?.[0];
    const audio = audioRef.current?.files?.[0];
    if (!image || !audio) {
      setLastError("Выберите изображение и аудио.");
      return;
    }
    if (!prompt.trim()) {
      setLastError("Введите prompt.");
      return;
    }
    const form = new FormData();
    form.append("image", image);
    form.append("audio", audio);
    form.append("prompt", prompt.trim());
    await startSession(form);
  };

  const videoUrl = pickAvatarVideoUrl(job);
  const showPlaceholderLayer = !(sessionState === "completed" && Boolean(videoUrl));
  const showBootOverlay = sessionState === "initializing";
  const showProgressRing = sessionState === "processing";
  const showVideoLayer = Boolean(videoUrl && (sessionState === "hydrating" || sessionState === "completed"));
  const isUploading = sessionState === "uploading";
  const sessionBusy = sessionState !== "idle" && sessionState !== "completed" && sessionState !== "failed";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">GPU Avatar Generate</h1>
        <p className="text-sm text-slate-600">
          Трафик идёт только через корпоративный gateway; внешний GPU‑воркер не вызывается напрямую из браузера.
        </p>
      </header>

      <section className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Статус сервисов</span>
          <button
            type="button"
            onClick={() => void loadHealth()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Обновить
          </button>
        </div>
        {healthError ? <p className="mt-2 text-rose-600">{healthError}</p> : null}
        {health ? (
          <ul className="mt-2 space-y-1 font-mono text-xs">
            <li>gpuReachable: {String(health.gpuReachable)}</li>
            <li>redisReachable: {String(health.redisReachable)}</li>
            <li>streamConfigured: {String(health.streamConfigured)}</li>
            <li>runtimeLatencyMs: {health.runtimeLatencyMs == null ? "null" : String(health.runtimeLatencyMs)}</li>
            <li>lastSuccessfulGenerationAt: {health.lastSuccessfulGenerationAt ?? "null"}</li>
          </ul>
        ) : (
          <p className="mt-2 text-slate-500">Загрузка…</p>
        )}
      </section>

      <section className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-800">Изображение (до 10 MB)</span>
          <input ref={imageRef} type="file" accept="image/*" className="block w-full text-sm" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-800">Аудио (до 20 MB)</span>
          <input ref={audioRef} type="file" accept="audio/*" className="block w-full text-sm" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-800">Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-inner"
            placeholder="Опишите желаемый результат…"
          />
        </label>
        {lastError ? <p className="text-sm text-rose-600">{lastError}</p> : null}
        {sessionError ? <p className="text-sm text-rose-600">{sessionError}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={isUploading}
            onClick={() => void onGenerate()}
            className="min-w-[160px] flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
          >
            {isUploading ? "Загрузка…" : "Сгенерировать"}
          </button>
          {(sessionState === "completed" || sessionState === "failed") && (
            <button
              type="button"
              onClick={() => {
                resetSession();
                setLastError(null);
              }}
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Новая сессия
            </button>
          )}
        </div>
      </section>

      {sessionState !== "idle" || job ? (
        <section className="space-y-3 rounded-xl border border-slate-100 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">Сессия</h2>
            <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
              {sessionLabel(sessionState)}
            </span>
          </div>
          {job?.id ? (
            <div className="space-y-0.5 font-mono text-[10px] text-slate-500">
              <p>job: {job.id}</p>
              {job.state ? <p>backend: {job.state}</p> : null}
              {typeof job.retryCount === "number" ? <p>retryCount: {job.retryCount}</p> : null}
            </div>
          ) : null}
          {sessionBusy ? (
            <p className="text-xs text-slate-500">Опрос состояния каждые 2 с (безопасно при переподключении)</p>
          ) : null}
          {generatedElapsedSec != null ? (
            <p className="text-sm font-medium text-emerald-700">
              Generated in {generatedElapsedSec < 10 ? generatedElapsedSec.toFixed(1) : Math.round(generatedElapsedSec)}s
            </p>
          ) : null}

          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-200 bg-black shadow-inner">
            {showPlaceholderLayer ? (
              <div
                className={`absolute inset-0 z-10 transition-opacity duration-500 ease-out ${
                  crossfadeMedia ? "opacity-0" : "opacity-100"
                }`}
              >
                <AvatarWarmupPlaceholder
                  showRing={showProgressRing}
                  bootLogs={showBootOverlay ? bootLogs : []}
                />
              </div>
            ) : null}
            {showVideoLayer && videoUrl ? (
              <video
                key={videoUrl}
                src={videoUrl}
                className={`absolute inset-0 z-20 h-full w-full object-contain transition-opacity duration-500 ease-out ${
                  crossfadeMedia ? "opacity-100" : "opacity-0"
                }`}
                controls
                muted
                playsInline
                loop={false}
                autoPlay
                onLoadedData={() => onHydrationReady()}
              />
            ) : null}
          </div>

          <p className="text-[11px] leading-snug text-slate-500">
            Транспорт: HTTP poll 2 с. Тип <span className="font-mono">AvatarSessionTransport</span> в{" "}
            <span className="font-mono">lib/avatar-session-state.ts</span> — точка расширения под WebSocket‑стрим.
          </p>
        </section>
      ) : null}
    </div>
  );
}
