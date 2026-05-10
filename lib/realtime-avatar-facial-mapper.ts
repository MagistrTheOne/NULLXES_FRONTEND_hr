import type { RealtimeFacialCoefficients } from "@/lib/realtime-avatar-socket";

/** Matches `AvatarFallbackAnimationState` in `avatar-stream-card.tsx` (CSS-driven placeholder). */
export type HrAvatarPlaceholderMotion = {
  mouthOpen: number;
  browRaise: number;
  smile: number;
  eyeBlink: number;
  headTiltDeg: number;
};

export function mapRealtimeCoefficientsToHrPlaceholder(c: RealtimeFacialCoefficients): HrAvatarPlaceholderMotion {
  const blink = Math.max(c.blinkLeft, c.blinkRight);
  return {
    mouthOpen: c.mouthOpen,
    browRaise: c.browRaise,
    smile: Math.min(1, c.emotionIntensity * 0.88 + c.idleMotion * 0.12),
    eyeBlink: blink,
    headTiltDeg: Number(((c.idleMotion - 0.5) * 10).toFixed(2))
  };
}
