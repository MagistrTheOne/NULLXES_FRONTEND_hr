import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const enabled = process.env.HR_AVATAR_FALLBACK_ENABLED === "1";
  const shareUrl = process.env.HR_AVATAR_FALLBACK_PERSONA_SHARE_URL?.trim() ?? "";
  const safeShareUrl = /^https?:\/\//i.test(shareUrl) ? shareUrl : "";

  return NextResponse.json({
    enabled: enabled && safeShareUrl.length > 0,
    shareUrl: safeShareUrl
  });
}
