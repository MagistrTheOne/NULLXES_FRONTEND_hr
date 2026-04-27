import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    enabled: process.env.HR_AVATAR_FALLBACK_ENABLED === "1"
  });
}
