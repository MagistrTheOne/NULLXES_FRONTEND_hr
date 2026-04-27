import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const enabled = process.env.HR_AVATAR_FALLBACK_ENABLED === "1";
  const shareUrl = process.env.HR_AVATAR_FALLBACK_PERSONA_SHARE_URL?.trim() ?? "";
  const safeShareUrl = /^https?:\/\//i.test(shareUrl) ? shareUrl : "";
  const passthroughEnabled = process.env.HR_AVATAR_FALLBACK_AUDIO_PASSTHROUGH_ENABLED === "1";
  const hasSessionTokenConfig = Boolean(
    process.env.HR_AVATAR_FALLBACK_API_KEY?.trim() &&
      (process.env.HR_AVATAR_FALLBACK_PERSONA_ID?.trim() || process.env.HR_AVATAR_FALLBACK_AVATAR_ID?.trim())
  );

  return NextResponse.json({
    enabled: enabled && safeShareUrl.length > 0,
    shareUrl: safeShareUrl,
    audioPassthroughEnabled: enabled && passthroughEnabled && hasSessionTokenConfig
  });
}
