"use client";

import type { LiveCaptions } from "@/hooks/use-interview-session";

interface LiveCaptionsOverlayProps {
  captions: LiveCaptions;
  visible?: boolean;
}
 
export function LiveCaptionsOverlay({ captions, visible = true }: LiveCaptionsOverlayProps) {
  if (!visible) return null;
  const hasAgent = Boolean(captions.agent && captions.agent.trim());
  const hasCandidate = Boolean(captions.candidate && captions.candidate.trim());
  if (!hasAgent && !hasCandidate) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-30 mx-auto flex w-full min-w-0 max-w-[min(100vw-1.5rem,42rem)] flex-col items-center gap-1 px-3 sm:px-4"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 88px)" }}
      aria-live="polite"
    >
      {hasAgent ? (
        <p className="w-full max-w-full wrap-break-word rounded-xl bg-black/70 px-3 py-2 text-sm leading-snug text-white shadow-lg backdrop-blur-sm sm:px-4">
          <span className="mr-2 text-xs uppercase tracking-wide text-sky-200">HR</span>
          {captions.agent}
        </p>
      ) : null}
      {hasCandidate ? (
        <p className="w-full max-w-full wrap-break-word rounded-xl bg-black/70 px-3 py-2 text-sm leading-snug text-white shadow-lg backdrop-blur-sm sm:px-4">
          <span className="mr-2 text-xs uppercase tracking-wide text-emerald-200">Вы</span>
          {captions.candidate}
        </p>
      ) : null}
    </div>
  );
}
