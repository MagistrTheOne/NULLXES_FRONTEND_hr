import { NextRequest, NextResponse } from "next/server";
import { StreamClient } from "@stream-io/node-sdk";

import { resolveBackendGatewayBaseUrl } from "@/lib/backend-gateway-env";
import { hasTrustedAppUser } from "@/lib/server-app-trust";

export const runtime = "nodejs";

type TokenRequestBody = {
  meetingId?: string;
  role?: "candidate" | "spectator" | "admin";
  userId?: string;
  userName?: string;
  callId?: string;
  callType?: string;
  participantId?: string;
  /** Подписанная ссылка наблюдателя; связывает meeting с interview (GET /join/spectator + runtime). */
  joinToken?: string;
};

type MeetingLookupResponse = {
  meeting?: {
    status?: string;
  };
};

const ACTIVE_MEETING_STATUSES = new Set(["starting", "in_meeting"]);

function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

async function verifySpectatorJoinTokenToMeeting(
  backendUrl: string,
  joinToken: string,
  expectedMeetingId: string
): Promise<boolean> {
  const joinRes = await fetch(`${backendUrl}/join/spectator/${encodeURIComponent(joinToken)}`, {
    method: "GET",
    cache: "no-store"
  }).catch(() => null);
  if (!joinRes?.ok) {
    return false;
  }
  const joinBody = (await joinRes.json().catch(() => ({}))) as { jobAiId?: unknown };
  const jobAiId = Number(joinBody.jobAiId);
  if (!Number.isInteger(jobAiId) || jobAiId <= 0) {
    return false;
  }
  const rtRes = await fetch(`${backendUrl}/runtime/by-interview/${encodeURIComponent(String(jobAiId))}`, {
    method: "GET",
    cache: "no-store"
  }).catch(() => null);
  if (!rtRes?.ok) {
    return false;
  }
  const snap = (await rtRes.json().catch(() => ({}))) as { meetingId?: unknown };
  const snapMeetingRaw = typeof snap.meetingId === "string" ? snap.meetingId : "";
  const snapMeeting = sanitizeIdentifier(snapMeetingRaw, "");
  return snapMeeting.length > 0 && snapMeeting === expectedMeetingId;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.STREAM_API_KEY;
  const secret = process.env.STREAM_SECRET_KEY;

  if (!apiKey || !secret) {
    return NextResponse.json(
      { message: "Missing Stream configuration. Set STREAM_API_KEY and STREAM_SECRET_KEY." },
      { status: 500 }
    );
  }

  const backendUrl = resolveBackendGatewayBaseUrl();
  if (!backendUrl) {
    return NextResponse.json(
      { message: "Gateway misconfigured: BACKEND_GATEWAY_URL is required in production", code: "gateway.misconfigured" },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as TokenRequestBody;
  const role = body.role ?? "candidate";
  const rawMeetingId = body.meetingId?.trim();
  if (!rawMeetingId) {
    return NextResponse.json({ message: "meetingId is required for Stream token issuance." }, { status: 400 });
  }
  const meetingId = sanitizeIdentifier(rawMeetingId, "meeting");
  const userId = sanitizeIdentifier(body.userId ?? `${role}-${meetingId}`, `${role}-user`);
  const userName = (body.userName ?? (role === "candidate" ? "Candidate" : "Spectator")).trim() || "Participant";
  const callId = sanitizeIdentifier(body.callId ?? meetingId, meetingId);
  const callType = sanitizeIdentifier(body.callType ?? "default", "default");

  const meetingResponse = await fetch(`${backendUrl}/meetings/${encodeURIComponent(meetingId)}`, {
    method: "GET",
    cache: "no-store"
  }).catch(() => null);

  if (!meetingResponse) {
    return NextResponse.json(
      {
        message: "Meeting service unavailable. Retry in a few seconds.",
        code: "meeting.unavailable"
      },
      { status: 503 }
    );
  }

  if (meetingResponse.status === 404) {
    return NextResponse.json(
      {
        message: "Сессия не активна или уже завершена.",
        code: "meeting.not_active"
      },
      { status: 409 }
    );
  }

  if (!meetingResponse.ok) {
    return NextResponse.json(
      {
        message: "Failed to validate meeting state before Stream connect.",
        code: "meeting.check_failed"
      },
      { status: 502 }
    );
  }

  const meetingPayload = (await meetingResponse.json().catch(() => ({}))) as MeetingLookupResponse;
  const meetingStatus = meetingPayload.meeting?.status;
  if (!meetingStatus || !ACTIVE_MEETING_STATUSES.has(meetingStatus)) {
    return NextResponse.json(
      {
        message: "Эта сессия уже завершена. Повторный вход отключен.",
        code: "meeting.closed"
      },
      { status: 409 }
    );
  }

  if (role === "candidate") {
    const participantIdRaw = typeof body.participantId === "string" ? body.participantId : "";
    const participantId = sanitizeIdentifier(participantIdRaw, "");
    if (!participantId) {
      return NextResponse.json({ message: "participantId is required for candidate admission." }, { status: 400 });
    }
    const admissionResponse = await fetch(`${backendUrl}/meetings/${encodeURIComponent(meetingId)}/admission/candidate/acquire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        participantId,
        displayName: userName
      })
    }).catch(() => null);

    if (!admissionResponse) {
      return NextResponse.json(
        { message: "Admission service unavailable. Retry in a few seconds.", code: "admission.unavailable" },
        { status: 503 }
      );
    }
    if (!admissionResponse.ok) {
      const payload = (await admissionResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const message =
        typeof payload.message === "string" ? payload.message : "Кандидат уже подключен, ожидайте подтверждение HR.";
      return NextResponse.json(
        {
          message,
          code: typeof payload.code === "string" ? payload.code : "admission.denied",
          admission: payload
        },
        { status: admissionResponse.status }
      );
    }
  }

  if (role === "spectator") {
    const joinTokenRaw = typeof body.joinToken === "string" ? body.joinToken.trim() : "";
    const strict = process.env.STREAM_SPECTATOR_REQUIRE_JOIN_TOKEN === "1";
    const internalOk = await hasTrustedAppUser(request);

    if (strict && !internalOk && !joinTokenRaw) {
      return NextResponse.json(
        {
          message: "Для выдачи токена наблюдателя нужна подписанная ссылка или сессия HR.",
          code: "spectator.join_token_required"
        },
        { status: 403 }
      );
    }

    if (joinTokenRaw) {
      const ok = await verifySpectatorJoinTokenToMeeting(backendUrl, joinTokenRaw, meetingId);
      if (!ok) {
        return NextResponse.json(
          {
            message: "Ссылка наблюдателя не соответствует этой встрече или недействительна.",
            code: "spectator.join_token_invalid"
          },
          { status: 403 }
        );
      }
    }
  }

  const serverClient = new StreamClient(apiKey, secret);
  const token = serverClient.generateUserToken({
    user_id: userId,
    validity_in_seconds: 60 * 60
  });
  await fetch(`${backendUrl}/runtime/${encodeURIComponent(meetingId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "stream.token.issued",
      actor: "frontend.stream-token",
      payload: {
        role,
        userId,
        callId,
        callType
      }
    })
  }).catch(() => undefined);

  return NextResponse.json({
    apiKey,
    token,
    user: {
      id: userId,
      name: userName
    },
    callId,
    callType
  });
}
