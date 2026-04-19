"use client";

import type { LiveCaptions } from "@/hooks/use-interview-session";

interface LiveCaptionsOverlayProps {
  captions: LiveCaptions;
  /** Hide the overlay entirely (e.g. lobby / completed screens). */
  visible?: boolean;
}

/**
 * Subtitle-style overlay for the interview surface. Pinned bottom-center,
 * shows the most recent agent + candidate utterance. Each line auto-clears
 * ~8s after the last update (handled in the hook), so silence collapses
 * the overlay to nothing without us animating opacity here.
 */
export function LiveCaptionsOverlay({ captions, visible = true }: LiveCaptionsOverlayProps) {
  if (!visible) return null;
  const hasAgent = Boolean(captions.agent && captions.agent.trim());
  const hasCandidate = Boolean(captions.candidate && captions.candidate.trim());
  if (!hasAgent && !hasCandidate) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-24 z-30 mx-auto flex max-w-2xl flex-col items-center gap-1 px-4"
      aria-live="polite"
    >
      {hasAgent ? (
        <p className="rounded-xl bg-black/70 px-4 py-2 text-sm leading-snug text-white shadow-lg backdrop-blur-sm">
          <span className="mr-2 text-xs uppercase tracking-wide text-sky-200">HR</span>
          {captions.agent}
        </p>
      ) : null}
      {hasCandidate ? (
        <p className="rounded-xl bg-black/70 px-4 py-2 text-sm leading-snug text-white shadow-lg backdrop-blur-sm">
          <span className="mr-2 text-xs uppercase tracking-wide text-emerald-200">Вы</span>
          {captions.candidate}
        </p>
      ) : null}
    </div>
  );
}
