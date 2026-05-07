import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_ANAM_AVATAR_ID = "4e3508cf-d7c4-4923-a6c5-6ddd50da8fe2";
const DEFAULT_ANAM_VOICE_ID = "8f58c168-0b0a-47a8-92b4-bc3a3f6e7d64";
const CUSTOMER_CLIENT_LLM_ID = "CUSTOMER_CLIENT_V1";

type AnamSessionTokenRequest = {
  meetingId?: string;
  sessionId?: string | null;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.ANAM_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { message: "ANAM_API_KEY is not configured", code: "anam.misconfigured" },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as AnamSessionTokenRequest;
  const meetingId = typeof body.meetingId === "string" && body.meetingId.trim() ? body.meetingId.trim() : "meeting";
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;

  const avatarId = process.env.ANAM_AVATAR_ID?.trim() || DEFAULT_ANAM_AVATAR_ID;
  const voiceId = process.env.ANAM_VOICE_ID?.trim() || DEFAULT_ANAM_VOICE_ID;
  const maxSessionLengthSeconds = readPositiveIntEnv("ANAM_MAX_SESSION_LENGTH_SECONDS", 1800);

  const response = await fetch("https://api.anam.ai/v1/auth/session-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      personaConfig: {
        name: "NULLXES HR ассистент",
        avatarId,
        voiceId,
        llmId: CUSTOMER_CLIENT_LLM_ID,
        skipGreeting: true,
        maxSessionLengthSeconds
      }
    })
  });

  const data = (await response.json().catch(() => ({}))) as {
    sessionToken?: unknown;
    error?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  if (!response.ok || typeof data.sessionToken !== "string") {
    return NextResponse.json(
      {
        message: "Failed to create Anam session token",
        code: "anam.session_token_failed",
        status: response.status,
        detail:
          typeof data.detail === "string"
            ? data.detail
            : typeof data.message === "string"
              ? data.message
              : typeof data.error === "string"
                ? data.error
                : data.detail ?? data.error
      },
      { status: response.ok ? 502 : response.status }
    );
  }

  return NextResponse.json({
    sessionToken: data.sessionToken,
    provider: "anam",
    meetingId,
    sessionId
  });
}
