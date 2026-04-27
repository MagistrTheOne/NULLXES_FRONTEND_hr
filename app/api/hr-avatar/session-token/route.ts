import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Temporary production fallback while env wiring is being stabilized.
// Remove once HR_AVATAR_FALLBACK_PERSONA_ID is reliably set in all environments.
const HARDCODED_PERSONA_ID = "22392fd9-f78f-4a89-9aa5-bc1b922d178e";

type SessionTokenResponse = {
  sessionToken?: string;
};

export async function POST(): Promise<NextResponse> {
  const apiKey = process.env.HR_AVATAR_FALLBACK_API_KEY?.trim() ?? "";
  const personaId = process.env.HR_AVATAR_FALLBACK_PERSONA_ID?.trim() || HARDCODED_PERSONA_ID;
  const avatarId = process.env.HR_AVATAR_FALLBACK_AVATAR_ID?.trim() ?? "";

  if (!apiKey) {
    return NextResponse.json({ message: "hr_avatar_api_key_missing" }, { status: 503 });
  }
  if (!personaId && !avatarId) {
    return NextResponse.json(
      { message: "hr_avatar_persona_or_avatar_id_missing" },
      { status: 503 }
    );
  }

  const body = personaId
    ? {
        personaConfig: {
          personaId,
          enableAudioPassthrough: true
        }
      }
    : {
        personaConfig: {
          avatarId,
          enableAudioPassthrough: true
        }
      };

  const response = await fetch("https://api.anam.ai/v1/auth/session-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    cache: "no-store"
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ message: "hr_avatar_provider_unavailable" }, { status: 503 });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json(
      { message: "hr_avatar_session_token_failed", upstreamStatus: response.status, upstreamBody: text.slice(0, 500) },
      { status: 502 }
    );
  }

  const payload = (await response.json().catch(() => ({}))) as SessionTokenResponse;
  const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken.trim() : "";
  if (!sessionToken) {
    return NextResponse.json({ message: "hr_avatar_session_token_empty" }, { status: 502 });
  }

  return NextResponse.json({ sessionToken });
}
