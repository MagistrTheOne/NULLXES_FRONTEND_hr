import { NextRequest, NextResponse } from "next/server";
import { StreamClient } from "@stream-io/node-sdk";
import { createHmac } from "node:crypto";

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
  /** Одноразовый signed observer ticket (issue/consume on backend). */
  observerTicket?: string;
};

type MeetingLookupResponse = {
  meeting?: {
    status?: string;
  };
};

type RuntimeLookupResponse = {
  meetingId?: unknown;
  media?: {
    streamCallId?: unknown;
    streamCallType?: unknown;
  };
};

const ACTIVE_MEETING_STATUSES = new Set(["starting", "in_meeting"]);

type SpectatorConsumedTicket = {
  meetingId?: unknown;
  jobAiId?: unknown;
  viewerKey?: unknown;
};

function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mintStreamAdminToken(apiSecret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ server: true }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", apiSecret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function streamAdminPost(
  apiKey: string,
  secret: string,
  url: string,
  body: unknown
): Promise<Response | null> {
  const adminToken = mintStreamAdminToken(secret);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: adminToken,
      "stream-auth-type": "jwt"
    },
    body: JSON.stringify(body)
  }).catch(() => null);
}

async function enforceSpectatorReadonlyRole(
  apiKey: string,
  secret: string,
  userId: string,
  userName: string,
  callType: string,
  callId: string
): Promise<void> {
  const usersUrl = `https://video.stream-io-api.com/api/v2/users?api_key=${encodeURIComponent(apiKey)}`;
  await streamAdminPost(apiKey, secret, usersUrl, {
    users: {
      [userId]: {
        id: userId,
        name: userName,
        role: "observer_readonly"
      }
    }
  });

  const callUrl = `https://video.stream-io-api.com/api/v2/video/call/${encodeURIComponent(callType)}/${encodeURIComponent(callId)}?api_key=${encodeURIComponent(apiKey)}`;
  await streamAdminPost(apiKey, secret, callUrl, {
    data: {
      members: [{ user_id: userId, role: "observer_readonly" }]
    }
  });
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
  if (!rawMeetingId && role !== "spectator") {
    return NextResponse.json({ message: "meetingId is required for Stream token issuance." }, { status: 400 });
  }
  let meetingId = sanitizeIdentifier(rawMeetingId ?? "", "meeting");
  let spectatorAuthorizedByTicket = false;
  let spectatorStableViewerKey: string | null = null;
  const observerTicketRaw = typeof body.observerTicket === "string" ? body.observerTicket.trim() : "";

  if (role === "spectator" && observerTicketRaw) {
    const consumeRes = await fetch(`${backendUrl}/join/spectator/session-ticket/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ observerTicket: observerTicketRaw })
    }).catch(() => null);

    if (!consumeRes) {
      return NextResponse.json(
        { message: "Observer ticket service unavailable", code: "spectator.ticket_unavailable" },
        { status: 503 }
      );
    }
    if (!consumeRes.ok) {
      const payload = (await consumeRes.json().catch(() => ({}))) as { error?: string };
      const code = payload.error ?? "spectator.ticket_invalid";
      const status = consumeRes.status === 409 ? 409 : consumeRes.status === 410 ? 410 : 403;
      return NextResponse.json(
        { message: "Observer ticket is invalid, expired, or already used.", code },
        { status }
      );
    }

    const consumed = (await consumeRes.json().catch(() => ({}))) as SpectatorConsumedTicket;
    const ticketMeetingIdRaw = typeof consumed.meetingId === "string" ? consumed.meetingId : "";
    const ticketMeetingId = sanitizeIdentifier(ticketMeetingIdRaw, "");
    const viewerKeyRaw = typeof consumed.viewerKey === "string" ? consumed.viewerKey : "";
    const viewerKey = sanitizeIdentifier(viewerKeyRaw, "");
    if (!ticketMeetingId) {
      return NextResponse.json(
        { message: "Observer ticket payload is malformed.", code: "spectator.ticket_malformed" },
        { status: 403 }
      );
    }
    meetingId = ticketMeetingId;
    spectatorStableViewerKey = viewerKey || null;
    spectatorAuthorizedByTicket = true;
  }

  if (!meetingId) {
    return NextResponse.json({ message: "meetingId is required for Stream token issuance." }, { status: 400 });
  }

  const spectatorServerUserId =
    role === "spectator" && spectatorStableViewerKey
      ? sanitizeIdentifier(`observer-${meetingId}-${spectatorStableViewerKey}`, `observer-${meetingId}`)
      : null;
  const userId = sanitizeIdentifier(body.userId ?? spectatorServerUserId ?? `${role}-${meetingId}`, `${role}-user`);
  const userName = (body.userName ?? (role === "candidate" ? "Candidate" : "Spectator")).trim() || "Participant";
  const callId = sanitizeIdentifier(body.callId ?? meetingId, meetingId);
  const callType = sanitizeIdentifier(body.callType ?? "default", "default");
  let resolvedCallId = callId;
  let resolvedCallType = callType;

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
    // Avoid extra auth/session DB roundtrip when strict mode is off:
    // this check can be slow and unnecessarily blocks observer Stream token issuance.
    const internalOk = strict ? await hasTrustedAppUser(request) : false;

    if (!spectatorAuthorizedByTicket && strict && !internalOk && !joinTokenRaw) {
      return NextResponse.json(
        {
          message: "Для выдачи токена наблюдателя нужна подписанная ссылка или сессия HR.",
          code: "spectator.join_token_required"
        },
        { status: 403 }
      );
    }

    if (!spectatorAuthorizedByTicket && joinTokenRaw) {
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

    // Spectator call binding is authoritative from runtime snapshot.
    const runtimeResponse = await fetch(`${backendUrl}/runtime/${encodeURIComponent(meetingId)}`, {
      method: "GET",
      cache: "no-store"
    }).catch(() => null);
    if (runtimeResponse?.ok) {
      const runtime = (await runtimeResponse.json().catch(() => ({}))) as RuntimeLookupResponse;
      const runtimeCallIdRaw =
        runtime?.media && typeof runtime.media.streamCallId === "string" ? runtime.media.streamCallId : "";
      const runtimeCallTypeRaw =
        runtime?.media && typeof runtime.media.streamCallType === "string" ? runtime.media.streamCallType : "";
      const runtimeCallId = sanitizeIdentifier(runtimeCallIdRaw, "");
      const runtimeCallType = sanitizeIdentifier(runtimeCallTypeRaw, "");
      resolvedCallId = runtimeCallId || meetingId;
      resolvedCallType = runtimeCallType || "default";
    } else {
      resolvedCallId = meetingId;
      resolvedCallType = "default";
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
        callId: resolvedCallId,
        callType: resolvedCallType
      }
    })
  }).catch(() => undefined);

  if (role === "spectator") {
    await enforceSpectatorReadonlyRole(apiKey, secret, userId, userName, resolvedCallType, resolvedCallId).catch(
      () => undefined
    );
  }

  return NextResponse.json({
    apiKey,
    token,
    user: {
      id: userId,
      name: userName
    },
    callId: resolvedCallId,
    callType: resolvedCallType
  });
}
