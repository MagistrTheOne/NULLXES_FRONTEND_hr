"use client";

import type { BridgeRuntimeSnapshot, RealtimeFacialCoefficients } from "@/lib/realtime-avatar-socket";

function MeterBar({
  label,
  value,
  colorClass
}: {
  label: string;
  value: number;
  colorClass: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[9px] font-medium uppercase tracking-wide text-white/70">
        <span>{label}</span>
        <span className="font-mono text-white/90">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-75 ease-out ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function BlinkEye({ closed, side }: { closed: boolean; side: "L" | "R" }) {
  return (
    <div
      className={`flex size-8 items-center justify-center rounded-full border text-[10px] font-bold transition-colors duration-75 ${
        closed ? "border-amber-400/80 bg-amber-500/25 text-amber-100" : "border-white/20 bg-white/5 text-white/60"
      }`}
      aria-label={side === "L" ? "Left blink" : "Right blink"}
    >
      {side}
    </div>
  );
}

export type RealtimeFacialMotionHudProps = {
  coefficients: RealtimeFacialCoefficients;
  connected: boolean;
  reconnecting: boolean;
  latencyMs: number | null;
  bridgeRuntime: BridgeRuntimeSnapshot;
};

export function RealtimeFacialMotionHud({
  coefficients,
  connected,
  reconnecting,
  latencyMs,
  bridgeRuntime
}: RealtimeFacialMotionHudProps) {
  const blinkL = coefficients.blinkLeft > 0.35;
  const blinkR = coefficients.blinkRight > 0.35;
  const mouth = coefficients.mouthOpen;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-end p-3">
      <div className="rounded-xl border border-white/15 bg-black/55 px-3 py-2.5 shadow-lg backdrop-blur-md">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-indigo-200/95">Live coefficients</span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-medium ${
              connected ? "bg-emerald-500/20 text-emerald-200" : reconnecting ? "bg-amber-500/20 text-amber-100" : "bg-white/10 text-white/50"
            }`}
          >
            {connected ? "WS" : reconnecting ? "…" : "off"}
          </span>
        </div>

        <div className="mb-2 flex items-center justify-center gap-3">
          <BlinkEye closed={blinkL} side="L" />
          <div
            className="relative h-10 w-14 rounded-full border border-white/20 bg-linear-to-b from-slate-800 to-slate-950 shadow-inner"
            aria-label="Mouth opening visualization"
          >
            <div
              className="absolute bottom-1 left-1/2 w-8 -translate-x-1/2 rounded-b-full bg-rose-500/70 transition-all duration-75"
              style={{
                height: `${8 + mouth * 22}px`,
                opacity: 0.35 + mouth * 0.55
              }}
            />
          </div>
          <BlinkEye closed={blinkR} side="R" />
        </div>

        <div className="grid grid-cols-1 gap-1.5">
          <MeterBar label="mouth" value={coefficients.mouthOpen} colorClass="bg-rose-400/90" />
          <MeterBar label="brow" value={coefficients.browRaise} colorClass="bg-violet-400/90" />
          <MeterBar label="emotion" value={coefficients.emotionIntensity} colorClass="bg-sky-400/90" />
          <MeterBar label="idle" value={coefficients.idleMotion} colorClass="bg-teal-400/90" />
          <MeterBar label="blink L" value={coefficients.blinkLeft} colorClass="bg-amber-300/90" />
          <MeterBar label="blink R" value={coefficients.blinkRight} colorClass="bg-amber-300/90" />
        </div>

        <div className="mt-2 border-t border-white/10 pt-2 font-mono text-[9px] text-white/55">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span>RTT {latencyMs == null ? "—" : `${latencyMs}ms`}</span>
            <span>EchoMimic {bridgeRuntime.echoMimic ?? "—"}</span>
            <span>A2F {bridgeRuntime.a2f ?? "—"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
